'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_MS = 15000;
const MIN_CHECK_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;

function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value || ''));
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  if (!a || !b) throw new Error('版本号格式无效');
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
function releaseTarget(platform, arch) {
  const windows = platform === 'win32';
  const supported = windows ? arch === 'x64' : platform === 'darwin' && ['arm64', 'x64'].includes(arch);
  const repo = `SJT-bright/${windows ? 'video-production-os-windows' : 'video-production-os'}`;
  return { repo, supported, starUrl: `https://github.com/${repo}`, latestUrl: `https://github.com/${repo}/releases/latest`,
    apiUrl: `https://api.github.com/repos/${repo}/releases/latest`, platform, arch };
}
function normalizeRelease(input, target) {
  if (!input || input.draft !== false || input.prerelease !== false || !versionParts(input.tag_name)
    || typeof input.published_at !== 'string' || !Number.isFinite(Date.parse(input.published_at))) return null;
  const tag = input.tag_name, version = tag.replace(/^v/, '');
  const prefix = `https://github.com/${target.repo}/releases/download/${encodeURIComponent(tag)}/`;
  const expected = target.platform === 'win32' ? `VideoProductionOS-Windows-v${version}-x64.zip`
    : `VideoProductionOS-Mac-v${version}-Universal.zip`;
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const validAsset = name => assets.find(asset => asset?.name === name && asset.state === 'uploaded'
    && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.browser_download_url === prefix + name);
  // A source push, tag, draft, prerelease or partially uploaded release is not an App update.
  const archive = validAsset(expected) || (target.platform === 'win32' && validAsset('VideoProductionOS-Windows-x64.zip'));
  if (!archive || !validAsset('SHA256SUMS.txt')) return null;
  return { tag, version, url: `https://github.com/${target.repo}/releases/tag/${encodeURIComponent(tag)}`,
    name: String(input.name || tag).slice(0, 180), notes: String(input.body || '').slice(0, 4000),
    publishedAt: input.published_at, assetName: archive.name };
}
async function readResponse(response) {
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429
    ? 'GitHub检查暂时受限，请稍后重试' : `GitHub暂时无法连接（HTTP ${response.status}）`);
  if (Number(response.headers?.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('更新信息过大');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('更新信息读取失败');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('更新信息过大'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createGitHubUpdates(options = {}) {
  const target = releaseTarget(options.platform || process.platform, options.arch || process.arch);
  const currentVersion = String(options.version || '0.0.0');
  // An optional update checker must not prevent developer/candidate builds
  // from launching or silently downgrade them to the stable channel.
  if (!versionParts(currentVersion)) {
    target.supported = false;
    target.disabledReason = '当前是测试构建，不自动检查正式版更新；请使用正式发布版';
  }
  const events = new EventEmitter();
  const now = options.now || Date.now;
  const fetchRelease = options.fetch || globalThis.fetch;
  const timers = options.timers || { setTimeout, clearTimeout, setInterval, clearInterval };
  const file = options.cacheFile;
  let latestRaw = null, release = null, checkedAt = 0, lastAttempt = 0, promptedVersion = '';
  let status = target.supported ? 'idle' : 'unsupported', error = '', cacheWarning = '';
  let pending = null, startup = null, interval = null, stopped = false, controller = null, revision = 0;
  let persistQueue = Promise.resolve();
  try {
    if (file && fs.statSync(file).size <= MAX_RESPONSE_BYTES) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.repo === target.repo && target.supported) {
        release = normalizeRelease(saved.latest, target);
        if (release) { latestRaw = saved.latest; checkedAt = Number(saved.checkedAt) || 0; }
        promptedVersion = versionParts(saved.promptedVersion) ? saved.promptedVersion.replace(/^v/, '') : '';
        if (checkedAt > now()) checkedAt = 0;
        lastAttempt = Math.min(Number(saved.lastAttempt) || 0, now());
        if (release) status = compareVersions(release.version, currentVersion) > 0 ? 'available' : 'up-to-date';
      }
    }
  } catch { /* Missing or damaged cache never prevents launch. */ }

  function snapshot() {
    return { ...target, currentVersion, status, revision, checking: status === 'checking',
      available: !!release && compareVersions(release.version, currentVersion) > 0,
      release: release ? { ...release } : null, checkedAt, error, cacheWarning,
      promptedVersion, intervalHours: INTERVAL_MS / 3600000, automaticInstall: false };
  }
  function broadcast() { if (!stopped) { revision++; events.emit('state', snapshot()); } }
  function persist() {
    if (!file) return Promise.resolve();
    const contents = JSON.stringify({ repo: target.repo, latest: latestRaw, checkedAt, lastAttempt, promptedVersion });
    const temporary = file + '.tmp';
    persistQueue = persistQueue.then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(temporary, contents, { mode: 0o600 });
      await fs.promises.rename(temporary, file);
      cacheWarning = '';
    }).catch(() => { cacheWarning = '更新检查记录未能保存，不影响素材和网页'; });
    return persistQueue;
  }
  async function runCheck(manual) {
    if (!target.supported || stopped) return snapshot();
    if (!manual && lastAttempt && now() - lastAttempt < MIN_CHECK_MS) {
      if (snapshot().available && promptedVersion !== release.version) events.emit('available', snapshot());
      return snapshot();
    }
    lastAttempt = now(); status = 'checking'; error = ''; broadcast();
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 12000); timeout.unref?.();
    try {
      const response = await fetchRelease(target.apiUrl, { signal: controller.signal, redirect: 'error',
        credentials: 'omit', cache: 'no-store', headers: {
          Accept: 'application/vnd.github+json', 'User-Agent': `VideoProductionOS/${currentVersion}`,
          'X-GitHub-Api-Version': '2022-11-28',
        } });
      const raw = await readResponse(response);
      const found = normalizeRelease(raw, target);
      if (!found) throw new Error('正式版安装包尚未发布完整，请稍后重试');
      if (stopped) return snapshot();
      // Persist only the fields needed for a future offline indication, never credentials/user data.
      latestRaw = { tag_name: raw.tag_name, draft: false, prerelease: false, published_at: raw.published_at,
        name: found.name, body: found.notes, assets: raw.assets.filter(asset => [found.assetName, 'SHA256SUMS.txt'].includes(asset?.name))
          .map(({ name, size, state, browser_download_url }) => ({ name, size, state, browser_download_url })) };
      release = found; checkedAt = now();
      status = compareVersions(found.version, currentVersion) > 0 ? 'available' : 'up-to-date';
    } catch (failure) {
      if (stopped) return snapshot();
      status = 'error'; error = failure?.name === 'AbortError' ? '检查更新超时，请检查网络后重试' : String(failure.message || '检查更新失败').slice(0, 200);
    } finally { clearTimeout(timeout); controller = null; }
    if (stopped) return snapshot();
    await persist();
    if (stopped) return snapshot();
    broadcast();
    if (!manual && snapshot().available && promptedVersion !== release.version) events.emit('available', snapshot());
    return snapshot();
  }
  function check({ manual = false } = {}) {
    if (pending) return pending;
    pending = runCheck(manual).finally(() => { pending = null; });
    return pending;
  }
  function start() {
    if (stopped || !target.supported || startup || interval) return;
    startup = timers.setTimeout(() => { startup = null; check().catch(() => {}); }, STARTUP_MS); startup?.unref?.();
    interval = timers.setInterval(() => check().catch(() => {}), INTERVAL_MS); interval?.unref?.();
  }
  function stop() {
    stopped = true; controller?.abort();
    if (startup) timers.clearTimeout(startup);
    if (interval) timers.clearInterval(interval);
    startup = interval = null;
  }
  return { snapshot, check, start, stop,
    onState: callback => { events.on('state', callback); return () => events.off('state', callback); },
    onAvailable: callback => { events.on('available', callback); return () => events.off('available', callback); },
    notePrompted: async version => { if (release?.version === version) { promptedVersion = version; await persist(); } },
  };
}

module.exports = { createGitHubUpdates, compareVersions, versionParts, releaseTarget, normalizeRelease,
  INTERVAL_MS, STARTUP_MS, MIN_CHECK_MS, MAX_RESPONSE_BYTES };
