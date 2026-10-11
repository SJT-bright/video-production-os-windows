'use strict';

const path = require('node:path');

const GPT_ORIGIN = 'https://chatgpt.com';
const selectedFilePolicies = new WeakMap();

function originOf(value) {
  try { return new URL(String(value || '')).origin; } catch { return ''; }
}

function isReadableGPTFileRequest(requestingOrigin, details = {}) {
  if (details.fileAccessType !== 'readable' || details.isDirectory !== false) return false;
  if (typeof details.filePath !== 'string' || !path.isAbsolute(details.filePath)) return false;
  const origin = originOf(requestingOrigin || details.requestingUrl);
  if (origin !== GPT_ORIGIN) return false;
  if (details.requestingUrl && originOf(details.requestingUrl) !== GPT_ORIGIN) return false;
  if (details.embeddingOrigin && originOf(details.embeddingOrigin) !== GPT_ORIGIN) return false;
  return true;
}

function isLiveGPTContents(contents, ses) {
  return !!contents && typeof contents.getURL === 'function' && !contents.isDestroyed?.()
    && contents.session === ses && originOf(contents.getURL()) === GPT_ORIGIN;
}

// Only an isolated preload's trusted drop/file-input event can register these
// exact paths. This is an in-memory read grant, not an API exposed to the page.
// Electron 43 supplies webContents:null for fileSystem checks; an actual selected
// path and its still-live, same-origin owner are required even in that case.
function createCreatorFileReadPolicy(ses) {
  if (selectedFilePolicies.has(ses)) return selectedFilePolicies.get(ses);
  const owners = new Map();
  const observedOwners = new WeakSet();
  const policy = {
    authorize(event, paths) {
      const contents = event?.sender;
      const frame = event?.senderFrame;
      if (!isLiveGPTContents(contents, ses) || !frame || frame !== contents.mainFrame
          || frame !== frame.top || originOf(frame.url) !== GPT_ORIGIN || !Array.isArray(paths)) return false;
      if (paths.length === 0 || paths.length > 100 || paths.some(value => typeof value !== 'string'
          || value.length > 32768 || !path.isAbsolute(value))) return false;
      if (!owners.has(contents)) {
        owners.set(contents, new Set());
      }
      if (!observedOwners.has(contents)) {
        observedOwners.add(contents);
        contents.once('destroyed', () => owners.delete(contents));
        // A full page navigation (including same-origin reload) starts a new
        // document. SPA history changes do not emit did-navigate.
        contents.on('did-navigate', () => owners.delete(contents));
      }
      const selected = owners.get(contents);
      for (const selectedPath of paths) selected.add(path.normalize(selectedPath));
      while (selected.size > 1000) selected.delete(selected.values().next().value);
      return true;
    },
    allows(contents, requestingOrigin, details = {}) {
      if (!isReadableGPTFileRequest(requestingOrigin, details)) return false;
      if (contents && !isLiveGPTContents(contents, ses)) return false;
      const selectedPath = path.normalize(details.filePath);
      for (const [owner, selected] of owners) {
        if ((!contents || contents === owner) && isLiveGPTContents(owner, ses) && selected.has(selectedPath)) return true;
      }
      return false;
    },
  };
  selectedFilePolicies.set(ses, policy);
  return policy;
}

function authorizeSelectedCreatorFileRead(event, paths) {
  let allowed = false;
  try {
    const policy = selectedFilePolicies.get(event.sender?.session);
    allowed = policy?.authorize(event, paths) === true;
  } catch {}
  // Exactly one reply, after the memory grant is registered. Replying false
  // first would unblock sendSync before authorization had completed.
  try { event.returnValue = allowed; } catch {}
  return allowed;
}

// No URL path/query, file name/path, request body, cookies or headers are logged.
// Observe the ordinary browser request; do not replay it or change its response.
function observeCreatorUploadFailures(ses, onFailure) {
  const filter = { urls: ['https://chatgpt.com/*', 'https://*.chatgpt.com/*',
    'https://*.oaiusercontent.com/*', 'https://*.openai.com/*'] };
  const summarize = (details, phase) => {
    let url;
    try { url = new URL(details.url); } catch { return; }
    if (!['POST', 'PUT', 'PATCH', 'OPTIONS'].includes(details.method)) return;
    if (!/(?:^|[\/-])(?:files?|uploads?|projects?)(?:[\/-]|$)/i.test(url.pathname)) return;
    const result = { phase, host: url.hostname, method: details.method };
    if (phase === 'http') {
      if (!Number.isInteger(details.statusCode) || details.statusCode < 400 || details.statusCode > 599) return;
      result.statusCode = details.statusCode;
    } else {
      result.errorCode = /^net::ERR_[A-Z0-9_]+$/.test(String(details.error || ''))
        ? details.error : 'NETWORK_ERROR';
    }
    onFailure(result);
  };
  ses.webRequest.onCompleted(filter, details => summarize(details, 'http'));
  ses.webRequest.onErrorOccurred(filter, details => summarize(details, 'network'));
}

module.exports = { createCreatorFileReadPolicy, authorizeSelectedCreatorFileRead, observeCreatorUploadFailures };
