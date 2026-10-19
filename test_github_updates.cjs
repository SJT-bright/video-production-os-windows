'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGitHubUpdates, compareVersions, normalizeRelease, releaseTarget, STARTUP_MS, INTERVAL_MS, MIN_CHECK_MS, MAX_RESPONSE_BYTES } = require('./electron/github-updates.cjs');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const target = releaseTarget('darwin', 'arm64');
function release(version = '1.3.12', platform = 'darwin') {
  const destination = releaseTarget(platform, platform === 'darwin' ? 'arm64' : 'x64');
  const archive = platform === 'win32' ? `VideoProductionOS-Windows-v${version}-x64.zip` : `VideoProductionOS-Mac-v${version}-Universal.zip`;
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-10-19T01:00:00Z', name: `正式版 v${version}`, body: '更新说明',
    assets: [archive, 'SHA256SUMS.txt'].map(name => ({ name, state: 'uploaded', size: 1234,
      browser_download_url: `https://github.com/${destination.repo}/releases/download/v${version}/${name}` })) };
}
const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const make = extra => createGitHubUpdates({ version: '1.3.11', platform: 'darwin', arch: 'arm64', fetch: async () => response(release()), ...extra });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-update-contract-'));
test('numeric versions do not compare 1.3.10 as older than 1.3.9', () => {
  assert.equal(compareVersions('1.3.10', '1.3.9'), 1); assert.equal(compareVersions('v1.3.11', '1.3.11'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1); assert.throws(() => compareVersions('latest', '1.0.0'));
});
test('platforms use their own public repositories and correct architecture', () => {
  assert.equal(target.starUrl, 'https://github.com/SJT-bright/video-production-os');
  assert.equal(releaseTarget('win32', 'x64').starUrl, 'https://github.com/SJT-bright/video-production-os-windows');
  assert.equal(releaseTarget('darwin', 'x64').supported, true); assert.equal(releaseTarget('win32', 'arm64').supported, false);
  assert.equal(releaseTarget('linux', 'x64').supported, false);
});
for (const [name, change] of [
  ['draft', r => { r.draft = true; }], ['prerelease', r => { r.prerelease = true; }],
  ['release candidate tag', r => { r.tag_name = 'v1.3.12-rc.1'; }], ['empty release', r => { r.assets = []; }],
  ['missing checksums', r => { r.assets.pop(); }], ['wrong platform', r => { r.assets[0].name = 'windows.zip'; }],
  ['unuploaded package', r => { r.assets[0].state = 'new'; }], ['empty package', r => { r.assets[0].size = 0; }],
  ['external asset URL', r => { r.assets[0].browser_download_url = 'https://example.com/app.zip'; }],
  ['invalid publication time', r => { r.published_at = 'not-a-time'; }],
]) test(`reject ${name} as an App update`, () => { const r = release(); change(r); assert.equal(normalizeRelease(r, target), null); });
test('do not trust a remote html_url for navigation', () => {
  const raw = release(); raw.html_url = 'https://example.com/phishing';
  assert.equal(normalizeRelease(raw, target).url, target.starUrl + '/releases/tag/v1.3.12');
});
test('new release emits automatic notice and ordered checking/available state', async () => {
  const service = make(); const states = [], notices = [];
  service.onState(state => states.push(state)); service.onAvailable(state => notices.push(state));
  const result = await service.check();
  assert.equal(result.available, true); assert.equal(result.automaticInstall, false); assert.equal(notices.length, 1);
  assert.deepEqual(states.map(s => s.status), ['checking', 'available']); assert.ok(states[1].revision > states[0].revision); service.stop();
});
test('manual check never creates a second automatic prompt', async () => {
  const service = make(); let notices = 0; service.onAvailable(() => notices++);
  assert.equal((await service.check({ manual: true })).available, true); assert.equal(notices, 0); service.stop();
});
test('same or older release never causes downgrade/update prompt', async () => {
  for (const version of ['1.3.11', '1.3.8']) {
    const service = make({ fetch: async () => response(release(version)) }); let notices = 0; service.onAvailable(() => notices++);
    assert.equal((await service.check()).available, false); assert.equal(service.snapshot().status, 'up-to-date'); assert.equal(notices, 0); service.stop();
  }
});
test('Windows checks Windows packages and never Mac packages', async () => {
  let requested;
  const service = make({ platform: 'win32', arch: 'x64', fetch: async url => { requested = url; return response(release('1.3.12', 'win32')); } });
  assert.equal((await service.check()).available, true); assert.ok(requested.includes('video-production-os-windows/')); service.stop();
});
test('published older Windows filename remains compatible', () => {
  const raw = release('1.3.8', 'win32'), destination = releaseTarget('win32', 'x64');
  raw.assets[0].name = 'VideoProductionOS-Windows-x64.zip';
  raw.assets[0].browser_download_url = `${destination.starUrl}/releases/download/v1.3.8/${raw.assets[0].name}`;
  assert.equal(normalizeRelease(raw, destination).version, '1.3.8');
});
test('unsupported architecture does not fetch an installer', async () => {
  let calls = 0; const service = make({ platform: 'win32', arch: 'arm64', fetch: async () => { calls++; return response(release()); } });
  assert.equal((await service.check({ manual: true })).status, 'unsupported'); assert.equal(calls, 0); service.stop();
});
test('developer and candidate versions never prevent App launch or force a downgrade', async () => {
  for (const version of ['1.3.0-rc.2', 'development']) {
    let calls = 0; const service = make({ version, fetch: async () => { calls++; return response(release()); } });
    assert.equal((await service.check({ manual: true })).status, 'unsupported'); assert.equal(calls, 0);
    assert.equal(service.snapshot().available, false); assert.ok(service.snapshot().disabledReason); service.stop();
  }
});
test('concurrent callers share one request; no browser credentials are sent', async () => {
  let complete, calls = 0, options;
  const service = make({ fetch: async (_url, opt) => { calls++; options = opt; return new Promise(resolve => { complete = resolve; }); } });
  const a = service.check(), b = service.check({ manual: true }); assert.equal(a, b); assert.equal(calls, 1);
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
  complete(response(release())); await a; service.stop();
});
test('cache and prompted version survive restart; cached release cannot change repository', async () => {
  const cacheFile = path.join(temp, 'cache.json'); const service = make({ cacheFile });
  await service.check(); await service.notePrompted('1.3.12'); service.stop();
  const again = make({ cacheFile }); assert.equal(again.snapshot().available, true); assert.equal(again.snapshot().promptedVersion, '1.3.12');
  let notices = 0; again.onAvailable(() => notices++); await again.check(); assert.equal(notices, 0); again.stop();
  const windows = make({ platform: 'win32', arch: 'x64', cacheFile }); assert.equal(windows.snapshot().available, false); windows.stop();
});
test('unknown/corrupt cache never blocks App startup', () => {
  const cacheFile = path.join(temp, 'corrupt.json'); fs.writeFileSync(cacheFile, 'not json');
  const service = make({ cacheFile }); assert.equal(service.snapshot().status, 'idle'); service.stop();
});
test('automatic retries are throttled; manual retry remains available', async () => {
  let time = Date.now(), calls = 0;
  const service = make({ now: () => time, fetch: async () => { calls++; return response(release()); } });
  await service.check(); await service.check(); assert.equal(calls, 1);
  await service.check({ manual: true }); assert.equal(calls, 2);
  time += MIN_CHECK_MS + 1; await service.check(); assert.equal(calls, 3); service.stop();
});
test('403/offline/invalid JSON are visible errors, not a false up-to-date result', async () => {
  for (const fetch of [async () => new Response('{}', { status: 403 }), async () => { throw Error('offline'); }, async () => new Response('bad json')]) {
    const service = make({ fetch }); const result = await service.check(); assert.equal(result.status, 'error'); assert.ok(result.error); assert.equal(result.available, false); service.stop();
  }
});
test('failed recheck retains previously verified available release', async () => {
  let fail = false; const service = make({ fetch: async () => { if (fail) throw Error('offline'); return response(release()); } });
  await service.check(); fail = true; const result = await service.check({ manual: true });
  assert.equal(result.status, 'error'); assert.equal(result.available, true); assert.equal(result.release.version, '1.3.12'); service.stop();
});
test('oversized response is bounded', async () => {
  const service = make({ fetch: async () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)) });
  assert.equal((await service.check()).status, 'error'); assert.match(service.snapshot().error, /过大/); service.stop();
});
test('schedule checks after startup and every six hours; stop clears owned timers', () => {
  const delays = [], cleared = [];
  const timers = { setTimeout: (_fn, ms) => { delays.push(ms); return { id: 'startup' }; }, setInterval: (_fn, ms) => { delays.push(ms); return { id: 'interval' }; },
    clearTimeout: timer => cleared.push(timer.id), clearInterval: timer => cleared.push(timer.id) };
  const service = make({ timers }); service.start(); service.start();
  assert.deepEqual(delays, [STARTUP_MS, INTERVAL_MS]); service.stop(); assert.deepEqual(cleared, ['startup', 'interval']);
});
test('stop during request aborts and does not broadcast or show an update', async () => {
  let entered, signal; const gate = new Promise(resolve => { entered = resolve; }); let notices = 0, changes = 0;
  const service = make({ fetch: async (_url, options) => { signal = options.signal; entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))); } });
  service.onAvailable(() => notices++); service.onState(() => changes++);
  const result = service.check(); await gate; service.stop(); await result;
  assert.equal(signal.aborted, true); assert.equal(changes, 1); assert.equal(notices, 0);
});

(async () => {
  try { for (const item of tests) { await item.run(); console.log('PASS ' + item.name); } console.log(`GITHUB_UPDATES_PASS ${tests.length} groups`); }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
