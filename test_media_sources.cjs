'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MEDIA_SOURCE_CONFIG_VERSION,
  PROJECT_MEDIA_SOURCE_ID,
  PROJECT_MEDIA_TYPES,
  EXTERNAL_MEDIA_TYPES,
  createMediaSourceStore,
  normalizeMediaSourceLabel,
  normalizeMediaRelativePath,
  classifyMediaFile,
} = require('./electron/media-sources.cjs');

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-media-sources-'));
const homeRoot = path.join(runRoot, 'home');
const projectRoot = path.join(homeRoot, 'Projects', '青春校园短剧');
const projectAssetRoot = path.join(projectRoot, '素材库');
const dataRoot = path.join(homeRoot, 'Library', 'VideoOS');
const configPath = path.join(dataRoot, 'media-sources.json');
const downloadsRoot = path.join(homeRoot, 'Downloads');
const customParent = path.join(homeRoot, 'Media');
const customRoot = path.join(customParent, 'AI成片');
const uuids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
];

function idFactory() {
  const uuid = uuids.shift();
  if (!uuid) throw new Error('测试 UUID 已用完');
  return uuid;
}

function write(relativePath, content = 'media') {
  const target = path.join(runRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function makeStore(overrides = {}) {
  return createMediaSourceStore({
    filePath: configPath,
    projectRoot,
    projectAssetRoot,
    homeRoot,
    idFactory,
    ...overrides,
  });
}

function assertNoPathLeak(value, label) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(runRoot), false, `${label} 不应返回绝对目录`);
}

try {
  fs.mkdirSync(projectAssetRoot, { recursive: true });
  fs.mkdirSync(downloadsRoot, { recursive: true });
  fs.mkdirSync(customRoot, { recursive: true });
  fs.mkdirSync(path.join(homeRoot, 'Other'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });

  write('home/Projects/青春校园短剧/素材库/正片.mp4');
  write('home/Projects/青春校园短剧/素材库/对白.wav');
  write('home/Projects/青春校园短剧/素材库/海报.png');
  write('home/Projects/青春校园短剧/素材库/场次/转场.mov');
  write('home/Projects/青春校园短剧/素材库/.cache/隐藏.mp4');
  write('home/Downloads/下载画面.jpg');
  write('home/Downloads/下载视频.mov');
  write('home/Downloads/下载音频.wav');
  write('home/Media/AI成片/人物.webp');
  write('home/Media/AI成片/镜头.mkv');
  write('home/Media/AI成片/音乐.mp3');
  write('home/Media/AI成片/node_modules/依赖画面.png');

  assert.equal(normalizeMediaSourceLabel('  AIGC  素材  '), 'AIGC 素材');
  assert.throws(() => normalizeMediaSourceLabel('../素材'), /路径分隔符/);
  assert.equal(normalizeMediaRelativePath('场次\\转场.mov'), '场次/转场.mov');
  assert.equal(normalizeMediaRelativePath('../逃逸.mov'), null);
  assert.equal(normalizeMediaRelativePath('/绝对.mov'), null);
  assert.equal(normalizeMediaRelativePath('.cache/隐藏.mov'), null);
  assert.equal(normalizeMediaRelativePath('node_modules/依赖.mov'), null);
  assert.equal(classifyMediaFile('镜头.MP4'), 'video');
  assert.equal(classifyMediaFile('人物.avif'), 'image');
  assert.equal(classifyMediaFile('说明.txt'), null);

  assert.throws(() => createMediaSourceStore({
    filePath: 'relative.json', projectRoot, projectAssetRoot, homeRoot,
  }), /绝对路径/);

  const warnings = [];
  const store = makeStore({
    maxSources: 2,
    onWarning: warning => warnings.push(warning),
  });
  const initial = store.list({ downloadsPath: downloadsRoot });
  assert.equal(initial.length, 1);
  assert.deepEqual(initial[0], {
    id: PROJECT_MEDIA_SOURCE_ID,
    token: PROJECT_MEDIA_SOURCE_ID,
    label: '项目素材库',
    kind: 'project',
    builtIn: true,
    removable: false,
    mediaTypes: [...PROJECT_MEDIA_TYPES],
    available: true,
    status: 'online',
    isDownloads: false,
  });
  assertNoPathLeak(initial, 'list()');

  const downloads = store.addDirectory({
    label: 'Downloads', rootPath: downloadsRoot, kind: 'downloads',
  });
  assert.equal(downloads.id, 'source-11111111-1111-4111-8111-111111111111');
  assert.equal(downloads.token, downloads.id);
  assert.deepEqual(downloads.mediaTypes, [...EXTERNAL_MEDIA_TYPES]);
  assert.equal(downloads.isDownloads, true);
  assertNoPathLeak(downloads, 'addDirectory()');

  const custom = store.addDirectory({ label: 'AIGC 成片', rootPath: customRoot, kind: 'folder' });
  assert.equal(custom.id, 'source-22222222-2222-4222-8222-222222222222');
  assert.equal(store.list({ downloadsPath: downloadsRoot }).find(source => source.id === downloads.id).isDownloads, true);
  assert.equal(warnings.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf-8')), {
    version: MEDIA_SOURCE_CONFIG_VERSION,
    sources: [
      { id: downloads.id, label: 'Downloads', rootPath: fs.realpathSync(downloadsRoot), kind: 'downloads' },
      { id: custom.id, label: 'AIGC 成片', rootPath: fs.realpathSync(customRoot), kind: 'folder' },
    ],
  });
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600, '配置文件必须仅允许当前用户读写');
  }
  assert.equal(fs.readdirSync(dataRoot).some(name => name.endsWith('.tmp')), false);

  fs.mkdirSync(path.join(downloadsRoot, '子目录'), { recursive: true });
  assert.throws(() => store.addDirectory({ label: '重复', rootPath: downloadsRoot }), /重复或存在父子目录重叠/);
  assert.throws(() => store.addDirectory({ label: '子目录', rootPath: path.join(downloadsRoot, '子目录') }), /重叠/);
  assert.throws(() => store.addDirectory({ label: '父目录', rootPath: customParent }), /重叠/);
  assert.throws(() => store.addDirectory({ label: '第三个', rootPath: path.join(homeRoot, 'Other') }), /最多只能添加 2 个/);
  assert.throws(() => store.addDirectory({ label: '系统根', rootPath: path.parse(runRoot).root }), /文件系统根目录/);
  assert.throws(() => store.addDirectory({ label: '整个 HOME', rootPath: homeRoot }), /用户主目录/);
  assert.throws(() => store.addDirectory({ label: '整个项目', rootPath: projectRoot }), /项目根目录/);
  assert.throws(() => store.addDirectory({ label: '项目素材重复', rootPath: projectAssetRoot }), /重叠/);
  assert.throws(() => store.addDirectory({ label: 'OS', rootPath: __dirname }), /程序目录/);
  assert.throws(() => store.addDirectory({ label: '数据', rootPath: dataRoot }), /数据目录/);
  assert.throws(() => store.addDirectory({ label: 'Git', rootPath: path.join(projectRoot, '.git') }), /\.git/);
  assert.throws(() => store.addDirectory({ label: '依赖', rootPath: path.join(projectRoot, 'node_modules') }), /node_modules/);

  if (process.platform !== 'win32') {
    const symlinkRoot = path.join(homeRoot, 'Downloads-link');
    fs.symlinkSync(downloadsRoot, symlinkRoot, 'dir');
    assert.throws(() => store.addDirectory({ label: '软链接', rootPath: symlinkRoot }), /符号链接/);
    const linkedFile = path.join(customRoot, '链接镜头.mov');
    fs.symlinkSync(path.join(customRoot, '镜头.mkv'), linkedFile);
    assert.equal(store.resolveFile(custom.id, '链接镜头.mov'), null);
  }

  const scanned = store.scan();
  assert.deepEqual(scanned.counts, { video: 4, image: 2, audio: 3 });
  assert.equal(scanned.files.length, 9);
  assert.equal(scanned.files.some(file => file.name === '海报.png'), false, '项目源不应索引图片');
  assert.equal(scanned.files.some(file => file.name === '下载音频.wav'), true, '外部源应索引音频');
  assert.equal(scanned.files.some(file => file.name === '音乐.mp3'), true, '自选目录应索引音频');
  assert.equal(scanned.files.some(file => file.name === '隐藏.mp4'), false);
  assert.equal(scanned.files.some(file => file.name === '依赖画面.png'), false);
  assert.equal(scanned.sources.length, 3);
  assert.equal(scanned.sources.every(source => source.status === 'online'), true);
  assert.equal(scanned.truncated, false);
  assertNoPathLeak(scanned, 'scan()');

  const downloadedVideo = scanned.files.find(file => file.sourceId === downloads.id && file.name === '下载视频.mov');
  assert.ok(downloadedVideo);
  assert.match(downloadedVideo.assetKey, /^media-[a-f0-9]{64}$/);
  const resolvedVideo = store.resolveFile(downloads.id, '下载视频.mov');
  assert.equal(resolvedVideo.absolutePath, fs.realpathSync(path.join(downloadsRoot, '下载视频.mov')));
  assert.equal(resolvedVideo.assetKey, downloadedVideo.assetKey);
  assert.ok(store.resolveFile(downloads.id, '下载音频.wav'));
  assert.equal(store.resolveFile(downloads.id, '../下载视频.mov'), null);
  assert.equal(store.resolveFile(downloads.id, path.join(downloadsRoot, '下载视频.mov')), null);
  assert.equal(store.resolveFile('source-99999999-9999-4999-8999-999999999999', '下载视频.mov'), null);
  assert.equal(store.resolveFile(PROJECT_MEDIA_SOURCE_ID, '海报.png'), null);
  assert.ok(store.resolveFile(PROJECT_MEDIA_SOURCE_ID, '对白.wav'));

  const reloaded = makeStore();
  assert.deepEqual(reloaded.list().map(source => source.id), [PROJECT_MEDIA_SOURCE_ID, downloads.id, custom.id]);
  const reloadedVideo = reloaded.scan().files.find(file => file.sourceId === downloads.id && file.name === '下载视频.mov');
  assert.equal(reloadedVideo.assetKey, downloadedVideo.assetKey, '重启后 assetKey 必须稳定');
  assert.equal(reloaded.list().find(source => source.id === custom.id).token, custom.token, '来源 token 必须稳定');

  const movedCustomRoot = `${customRoot}-offline`;
  fs.renameSync(customRoot, movedCustomRoot);
  const offlineSource = reloaded.list().find(source => source.id === custom.id);
  assert.equal(offlineSource.status, 'offline');
  assert.equal(offlineSource.available, false);
  const offlineScan = reloaded.scan();
  assert.equal(offlineScan.sources.find(source => source.id === custom.id).status, 'offline');
  assert.equal(offlineScan.files.some(file => file.sourceId === custom.id), false);
  assert.equal(reloaded.resolveFile(custom.id, '镜头.mkv'), null);
  assert.equal(reloaded.remove(custom.id).status, 'offline');
  assert.equal(fs.existsSync(movedCustomRoot), true, '移除来源不得删除或移动磁盘目录');
  assert.equal(reloaded.remove(downloads.id).id, downloads.id);
  assert.equal(fs.existsSync(downloadsRoot), true, '移除 Downloads 来源不得删除目录或文件');
  assert.equal(fs.existsSync(path.join(downloadsRoot, '下载视频.mov')), true);
  assert.throws(() => reloaded.remove(PROJECT_MEDIA_SOURCE_ID), /内置来源/);
  assert.throws(() => reloaded.remove(downloads.id), /不存在/);

  const depthRoot = path.join(homeRoot, 'DepthSource');
  write('home/DepthSource/一级/二级/深层.png');
  write('home/DepthSource/一级/浅层.png');
  const depthStore = makeStore({
    filePath: path.join(homeRoot, 'DepthData', 'media-sources.json'),
    maxDepth: 1,
    idFactory,
  });
  const depthSource = depthStore.addDirectory({ label: '深度测试', rootPath: depthRoot, kind: 'folder' });
  const depthScan = depthStore.scan();
  assert.equal(depthScan.maxDepth, 1);
  assert.equal(depthScan.truncated, true);
  assert.equal(depthScan.sources.find(source => source.id === depthSource.id).truncated, true);
  assert.equal(depthScan.files.some(file => file.name === '浅层.png'), true);
  assert.equal(depthScan.files.some(file => file.name === '深层.png'), false);

  const limitedProjectRoot = path.join(homeRoot, 'LimitedProject');
  const limitedAssetRoot = path.join(limitedProjectRoot, '素材库');
  const limitedRoot = path.join(homeRoot, 'LimitedSource');
  fs.mkdirSync(limitedAssetRoot, { recursive: true });
  for (let index = 1; index <= 5; index++) write(`home/LimitedSource/${index}.jpg`);
  const limitedStore = createMediaSourceStore({
    filePath: path.join(homeRoot, 'LimitedData', 'media-sources.json'),
    projectRoot: limitedProjectRoot,
    projectAssetRoot: limitedAssetRoot,
    homeRoot,
    maxEntries: 2,
    idFactory,
  });
  const limitedSource = limitedStore.addDirectory({ label: '数量测试', rootPath: limitedRoot });
  const limitedScan = limitedStore.scan();
  assert.equal(limitedScan.maxEntries, 2);
  assert.equal(limitedScan.files.length, 2);
  assert.equal(limitedScan.truncated, true);
  assert.equal(limitedScan.sources.find(source => source.id === limitedSource.id).truncated, true);

  const damagedPath = path.join(homeRoot, 'DamagedData', 'media-sources.json');
  fs.mkdirSync(path.dirname(damagedPath), { recursive: true });
  fs.writeFileSync(damagedPath, '{not-json', 'utf-8');
  const damageWarnings = [];
  const damaged = makeStore({
    filePath: damagedPath,
    idFactory,
    onWarning: warning => damageWarnings.push(warning),
  });
  assert.deepEqual(damaged.list().map(source => source.id), [PROJECT_MEDIA_SOURCE_ID]);
  assert.equal(damaged.status().recovered, true);
  assert.equal(damaged.status().writable, true);
  assert.equal(damageWarnings.length, 1);
  assert.equal(fs.readdirSync(path.dirname(damagedPath)).some(name => name.includes('.corrupt-')), true);
  const recoveryRoot = path.join(homeRoot, 'RecoverySource');
  fs.mkdirSync(recoveryRoot, { recursive: true });
  assert.doesNotThrow(() => damaged.addDirectory({ label: '恢复来源', rootPath: recoveryRoot }));

  const futurePath = path.join(homeRoot, 'FutureData', 'media-sources.json');
  fs.mkdirSync(path.dirname(futurePath), { recursive: true });
  const futurePayload = JSON.stringify({ version: MEDIA_SOURCE_CONFIG_VERSION + 1, sources: [] });
  fs.writeFileSync(futurePath, futurePayload, 'utf-8');
  const future = makeStore({ filePath: futurePath });
  assert.deepEqual(future.list().map(source => source.id), [PROJECT_MEDIA_SOURCE_ID]);
  assert.equal(future.status().writable, false);
  assert.equal(fs.readFileSync(futurePath, 'utf-8'), futurePayload);
  assert.throws(() => future.addDirectory({ label: '不能覆盖', rootPath: recoveryRoot }), /不支持的媒体来源配置版本/);

  console.log('MEDIA_SOURCES PASS: safe registry, atomic persistence, scan boundaries, stable keys, offline/truncation and non-destructive removal');
} finally {
  const safePrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  assert.ok(path.resolve(runRoot).startsWith(safePrefix), '拒绝清理系统临时目录以外的路径');
  fs.rmSync(runRoot, { recursive: true, force: true });
}
