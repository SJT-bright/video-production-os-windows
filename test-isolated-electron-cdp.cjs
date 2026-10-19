'use strict';
// Test transport only. Connect to the exact child we spawn, never the running
// production App. Used when Playwright's Electron launch handshake stalls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(50); }
  throw new Error('Isolated direct CDP timed out: ' + label);
}
class Inspector {
  constructor(url) {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    this.ws = new WebSocket(url); this.id = 0; this.pending = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(event.data), waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer); this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
    this.ws.addEventListener('close', () => {
      for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Owned inspector closed')); }
      this.pending.clear();
    });
  }
  async evaluate(fn, arg) {
    await this.ready;
    const expression = '(' + fn.toString() + ')(require("electron"),' + JSON.stringify(arg ?? null) + ')';
    const response = await new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Owned inspector evaluation timed out')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true } }));
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }
  close() { this.ws.close(); }
}
async function launchIsolatedElectron({ executablePath, env }) {
  assert.equal(env.CREATOR_BROWSER_TEST, '1');
  const expectedRelease = process.platform === 'darwin'
    ? path.join(__dirname, 'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app/Contents/MacOS/VideoProductionOS')
    : process.platform === 'win32' ? path.join(__dirname, 'dist/视频制作OS-win32-x64/视频制作OS.exe') : null;
  assert.ok(executablePath.replace(/\\/g, '/').includes('/test-artifacts/')
    || (expectedRelease && path.resolve(executablePath) === expectedRelease), 'Only an explicitly isolated candidate or this checkout release is allowed');
  const requestedProfile = path.resolve(env.VIDEO_OS_USER_DATA);
  assert.ok(path.basename(path.dirname(requestedProfile)).startsWith('video-os-episodes-'));
  assert.equal(path.basename(requestedProfile), 'profile');
  if (!fs.existsSync(requestedProfile)) fs.mkdirSync(requestedProfile);
  const profile = fs.realpathSync.native(requestedProfile);
  let nodeURL = '', partial = '', stdout = '', serverReady = false, inspector;
  const child = spawn(executablePath, ['--inspect=0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8192); serverReady ||= stdout.includes('浏览器打开：'); });
  child.stderr.on('data', bytes => {
    partial += bytes;
    const lines = partial.split('\n'); partial = lines.pop();
    for (const line of lines) {
      const node = line.match(/^Debugger listening on (ws:\/\/\S+)/);
      if (node) nodeURL = node[1];
    }
  });
  const close = async () => {
    try { if (inspector) await inspector.evaluate(({ app }) => { setTimeout(() => app.quit(), 50); return true; }); } catch {}
    inspector?.close();
    if (!await Promise.race([exited.then(() => true), delay(5000).then(() => false)])) child.kill('SIGKILL');
    await Promise.race([exited, delay(2000)]);
  };
  try {
    await until(() => { if (child.exitCode !== null) throw new Error('Owned App exited before debug endpoints'); return nodeURL && serverReady; }, 'own debug endpoint and completed Electron bootstrap');
    inspector = new Inspector(nodeURL);
    const actual = await inspector.evaluate(({ app }) => ({ pid: process.pid, profile: app.getPath('userData') }));
    assert.equal(actual.pid, child.pid); assert.equal(fs.realpathSync.native(actual.profile), profile);
    const renderer = (fn, value, target = '/creator.html') => {
      assert.ok(['/creator.html', '/creator-assets.html', '/assets/ui/download-review.html'].includes(target));
      return inspector.evaluate(async ({ webContents }, request) => {
        const wc = webContents.getAllWebContents().find(wc => {
          if (wc.isDestroyed()) return false;
          try { const url = new URL(wc.getURL()); return ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === request.port && url.pathname === request.target; }
          catch { return false; }
        });
        if (!wc) throw new Error('Owned local renderer not ready');
        return wc.executeJavaScript('(' + request.fn + ')(' + JSON.stringify(request.value) + ')');
      }, { fn: fn.toString(), value: value ?? null, target, port: env.VIDEO_OS_PORT });
    };
    await until(() => renderer(() => document.body?.dataset.ready === 'true').catch(() => false), 'ready owned creator');
    return { evaluate: (fn, arg) => inspector.evaluate(fn, arg), renderer, close, process: () => child };
  } catch (error) { await close(); throw error; }
}
module.exports = { launchIsolatedElectron };
