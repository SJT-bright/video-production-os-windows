'use strict';

// 仅在候选独立 defaultSession 中读取已克隆的工作台 Local Storage。
// bootstrap HTTP 全由此 session 的 protocol handler 返回，不请求正式服务。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function localOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
    || url.username || url.password) throw new Error('候选状态迁移只允许本机 HTTP 工作台 origin');
  return url.origin;
}

function remapState(value, sourceRoot, targetRoot) {
  if (!sourceRoot || !targetRoot) return value;
  const remap = text => text === sourceRoot ? targetRoot
    : text.startsWith(`${sourceRoot}${path.sep}`) ? targetRoot + text.slice(sourceRoot.length) : text;
  if (typeof value === 'string') return remap(value);
  if (Array.isArray(value)) return value.map(item => remapState(item, sourceRoot, targetRoot));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [remap(key), remapState(item, sourceRoot, targetRoot)]));
  return value;
}

function mappedEntries(entries, seed) {
  return entries.map(([key, value]) => {
    try { return [key, JSON.stringify(remapState(JSON.parse(value), seed.sourceProject, seed.candidateWorkspace))]; }
    catch { return [key, remapState(value, seed.sourceProject, seed.candidateWorkspace)]; }
  });
}

async function migrateCandidateLocalStorage(options = {}) {
  const { app, BrowserWindow, session } = require('electron');
  const userData = path.resolve(options.userData || '');
  if (!options.userData || path.resolve(app.getPath('userData')) !== userData) {
    throw new Error('候选状态迁移必须使用当前 App 的独立 userData');
  }
  const targetOrigin = localOrigin(options.targetOrigin);
  const markerPath = path.join(userData, 'candidate-local-storage.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch {}
  const sourceOrigin = localOrigin(previous?.targetOrigin || options.sourceOrigin);
  if (previous?.targetOrigin && sourceOrigin === targetOrigin) return { ...previous, sourceOrigin, targetOrigin, skipped: true };
  let seed = {};
  try { seed = JSON.parse(fs.readFileSync(path.join(userData, 'candidate-seed.json'), 'utf8')); } catch {}
  const candidateSession = session.defaultSession;
  if (await candidateSession.protocol.isProtocolHandled('http')) throw new Error('候选 session 已有 HTTP handler，状态迁移已停止');
  const nonce = crypto.randomUUID();
  const bootstrapPath = `/__candidate_storage_${nonce}`;
  const allowed = new Set([sourceOrigin, targetOrigin]);
  let handledRequests = 0;
  let window;
  let registered = false;
  try {
    candidateSession.protocol.handle('http', request => {
      const url = new URL(request.url);
      if (!allowed.has(url.origin) || url.pathname !== bootstrapPath || request.method !== 'GET') {
        return new Response('blocked', { status: 403 });
      }
      handledRequests += 1;
      return new Response('<!doctype html><meta charset="utf-8"><title>Candidate storage</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'none'; connect-src 'none'" },
      });
    });
    registered = true;
    window = new BrowserWindow({ show: false, webPreferences: { session: candidateSession,
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await window.loadURL(`${sourceOrigin}${bootstrapPath}`);
    const sourceEntries = await window.webContents.executeJavaScript(`Object.keys(localStorage)
      .filter(key => /^(videoOS\\.|vos\\.)/.test(key)).sort().map(key => [key, localStorage.getItem(key)])`);
    const entries = mappedEntries(sourceEntries, seed);
    await window.loadURL(`${targetOrigin}${bootstrapPath}`);
    // 首次搬取快照不覆盖目标；后续换端口以最近一次候选 origin 为准，
    // 避免回到旧 origin 时旧快照盖掉新增创作。写入失败则还原目标当前值。
    const result = await window.webContents.executeJavaScript(`(() => {
      const entries = ${JSON.stringify(entries)};
      const authoritativeCandidate = ${!!previous?.targetOrigin || sourceOrigin === targetOrigin};
      const appKeys = () => Object.keys(localStorage).filter(key => /^(videoOS\\.|vos\\.)/.test(key));
      const before = appKeys().map(key => [key, localStorage.getItem(key)]);
      let copied = 0, preserved = 0, overwritten = 0;
      try {
        if (authoritativeCandidate) {
          const sourceKeys = new Set(entries.map(([key]) => key));
          for (const key of appKeys()) if (!sourceKeys.has(key)) localStorage.removeItem(key);
        }
        for (const [key, value] of entries) {
          const current = localStorage.getItem(key);
          if (current !== null && !authoritativeCandidate) { preserved += 1; continue; }
          localStorage.setItem(key, value);
          if (localStorage.getItem(key) !== value) throw new Error('Candidate local storage readback failed');
          if (current !== null) overwritten += 1; else copied += 1;
        }
      } catch (error) {
        for (const key of appKeys()) localStorage.removeItem(key);
        for (const [key, value] of before) localStorage.setItem(key, value);
        throw error;
      }
      return { copied, preserved, overwritten, sourceKeys: entries.length };
    })()`);
    await candidateSession.flushStorageData();
    const receipt = { schemaVersion: 1, migratedAt: new Date().toISOString(), sourceOrigin, targetOrigin,
      ...result, bootstrapRequestsIntercepted: handledRequests, externalSourceRequested: false,
      liveSourceSnapshotConsistency: seed.localStorage?.liveCopyConsistency || 'not guaranteed' };
    const temporary = `${markerPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, markerPath);
    return receipt;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    if (registered) candidateSession.protocol.unhandle('http');
  }
}

module.exports = { localOrigin, remapState, mappedEntries, migrateCandidateLocalStorage };
