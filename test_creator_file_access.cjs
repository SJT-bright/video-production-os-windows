'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createCreatorFileReadPolicy, authorizeSelectedCreatorFileRead,
  observeCreatorUploadFailures } = require('./electron/creator-file-access.cjs');

const selectedPath = path.join(os.tmpdir(), 'video-os-user-selected.txt');
const unknownPath = path.join(os.tmpdir(), 'video-os-not-selected.txt');
function contents(ses, url = 'https://chatgpt.com/project') {
  const value = new EventEmitter();
  value.session = ses; value.url = url; value.destroyed = false;
  value.getURL = () => value.url; value.isDestroyed = () => value.destroyed;
  value.mainFrame = { url }; value.mainFrame.top = value.mainFrame;
  return value;
}
function eventFor(value) { return { sender: value, senderFrame: value.mainFrame }; }
const details = { filePath: selectedPath, fileAccessType: 'readable', isDirectory: false, isMainFrame: false };
const ses = {};
const owner = contents(ses);
const policy = createCreatorFileReadPolicy(ses);
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), false, 'No grant from origin alone');
const registered = eventFor(owner);
authorizeSelectedCreatorFileRead(registered, [selectedPath]);
assert.equal(registered.returnValue, true);
const missingContext = { sender: owner, get senderFrame() { throw new Error('Disposed frame'); } };
assert.equal(authorizeSelectedCreatorFileRead(missingContext, [unknownPath]), false);
assert.equal(missingContext.returnValue, false);
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), true, 'Selected path with live known owner supports Electron null checks');
assert.equal(policy.allows(owner, 'https://chatgpt.com/', details), true);
for (const invalid of [
  { filePath: unknownPath }, { filePath: '' }, { filePath: 'relative.txt' },
  { fileAccessType: 'writable' }, { fileAccessType: 'readwrite' }, { fileAccessType: undefined },
  { isDirectory: true }, { isDirectory: undefined },
  { requestingUrl: 'https://untrusted.example/' }, { embeddingOrigin: 'https://untrusted.example/' },
]) assert.equal(policy.allows(null, 'https://chatgpt.com/', { ...details, ...invalid }), false, JSON.stringify(invalid));
for (const origin of ['', 'https://untrusted.example/', 'http://chatgpt.com/', 'https://chatgpt.com.untrusted.example/',
  'https://chatgpt.com:8443/', 'null']) assert.equal(policy.allows(null, origin, details), false, origin);
assert.equal(policy.allows(contents({}), 'https://chatgpt.com/', details), false, 'Wrong Session cannot use grant');
assert.equal(policy.allows(contents(ses, 'https://untrusted.example/'), 'https://chatgpt.com/', details), false);
assert.equal(policy.allows(contents(ses), 'https://chatgpt.com/', details), false, 'Unselected known WebContents is denied');
assert.equal(policy.authorize({ sender: owner, senderFrame: { url: owner.url, top: owner.mainFrame } }, [unknownPath]), false, 'Subframe authorization denied');
assert.equal(policy.authorize(eventFor(contents(ses, 'https://untrusted.example/')), [unknownPath]), false);
assert.equal(policy.authorize(eventFor(owner), [unknownPath, 'relative.txt']), false);
assert.equal(policy.authorize(eventFor(owner), Array(101).fill(selectedPath)), false);
owner.emit('did-navigate-in-page');
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), true, 'SPA navigation retains the current document grant');
owner.emit('did-navigate');
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), false, 'Full same-origin navigation revokes grant');
assert.equal(policy.authorize(eventFor(owner), [selectedPath]), true, 'Fresh user selection can reauthorize the same page');
owner.url = 'https://untrusted.example/'; owner.emit('did-navigate');
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), false, 'Navigate away revokes grant');
owner.url = 'https://chatgpt.com/project'; owner.mainFrame.url = owner.url;
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), false, 'Navigate back must not resurrect grant');
assert.equal(policy.authorize(eventFor(owner), [selectedPath]), true);
assert.equal(owner.listenerCount('did-navigate'), 1, 'Reauthorization must not accumulate listeners');
owner.destroyed = true; owner.emit('destroyed');
assert.equal(policy.allows(null, 'https://chatgpt.com/', details), false, 'Destroy revokes grant');

// Run the actual isolated-world authorization portion of preload with controlled
// DOM events: synthetic events / synthetic Files never reach the private IPC.
const preload = fs.readFileSync(path.join(__dirname, 'electron/creator-page-patch-preload.cjs'), 'utf8');
const authStart = preload.indexOf('if (window === window.top');
const authEnd = preload.indexOf('// 主世界没有 Node', authStart);
assert.ok(authStart >= 0 && authEnd > authStart);
function preloadController(origin, topLevel = true) {
  const listeners = {}, calls = [];
  const window = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  window.top = topLevel ? window : {};
  class Input {}
  const context = vm.createContext({ window, location: { origin }, HTMLInputElement: Input,
    webUtils: { getPathForFile: file => file.nativePath || '' },
    ipcRenderer: { sendSync: (channel, paths) => { calls.push({ channel, paths }); return true; } },
  });
  vm.runInContext(preload.slice(authStart, authEnd), context);
  return { listeners, calls, Input };
}
const preloadProbe = preloadController('https://chatgpt.com');
preloadProbe.listeners.drop({ isTrusted: false, dataTransfer: { files: [{ nativePath: selectedPath }] } });
preloadProbe.listeners.drop({ isTrusted: true, dataTransfer: { files: [{}] } });
assert.equal(preloadProbe.calls.length, 0, 'Synthetic event or non-native File denied');
preloadProbe.listeners.drop({ isTrusted: true, dataTransfer: { files: [{ nativePath: selectedPath }] } });
assert.equal(preloadProbe.calls.length, 1);
assert.equal(preloadProbe.calls[0].channel, 'creator:selected-file-read');
assert.equal(preloadProbe.calls[0].paths[0], selectedPath);
const fileInput = new preloadProbe.Input(); fileInput.type = 'file'; fileInput.files = [{ nativePath: selectedPath }];
preloadProbe.listeners.change({ isTrusted: false, target: fileInput });
assert.equal(preloadProbe.calls.length, 1);
preloadProbe.listeners.change({ isTrusted: true, target: fileInput });
assert.equal(preloadProbe.calls.length, 2);
assert.equal(Object.keys(preloadController('https://untrusted.example').listeners).length, 0);
assert.equal(Object.keys(preloadController('https://chatgpt.com', false).listeners).length, 0);
assert.equal(preloadProbe.calls.every(call => Object.keys(call).join(',') === 'channel,paths'), true);

const observers = {}, messages = [];
observeCreatorUploadFailures({ webRequest: {
  onCompleted: (filter, callback) => { observers.completed = { filter, callback }; },
  onErrorOccurred: (filter, callback) => { observers.error = { filter, callback }; },
} }, message => messages.push(message));
observers.completed.callback({ url: 'https://chatgpt.com/backend-api/files?private=secret', method: 'POST', statusCode: 403,
  requestHeaders: { Authorization: 'not-for-logs' }, uploadData: 'not-for-logs' });
observers.error.callback({ url: 'https://files.oaiusercontent.com/file-private?token=secret', method: 'PUT', error: 'net::ERR_FAILED' });
observers.completed.callback({ url: 'https://chatgpt.com/backend-api/files', method: 'POST', statusCode: 200 });
observers.error.callback({ url: 'https://chatgpt.com/backend-api/files', method: 'POST', error: 'bad https://user:secret@example.com/private' });
assert.equal(messages.length, 3);
assert.deepEqual(messages[0], { phase: 'http', host: 'chatgpt.com', method: 'POST', statusCode: 403 });
assert.deepEqual(messages[1], { phase: 'network', host: 'files.oaiusercontent.com', method: 'PUT', errorCode: 'net::ERR_FAILED' });
assert.equal(messages[2].errorCode, 'NETWORK_ERROR');
assert.doesNotMatch(JSON.stringify(messages), /private|secret|not-for-logs|Authorization|token|uploadData/);
console.log('CREATOR_FILE_ACCESS_POLICY_PASS trusted selection, same-origin read only, revocation, synthetic denial, redacted observers');
