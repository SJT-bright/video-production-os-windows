'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCreativeAssetTree } = require('./creative-assets.cjs');
const {
  classifyDownload,
  sanitizeFilename,
  dateFolder,
  uniquePath,
  resolveDownloadTarget,
  deleteBrowserDownloadFile,
  createBrowserDownloadDeletion,
  resolveSelectedDownloadDirectory,
} = require('./electron/download-router.cjs');

const fixedNow = new Date('2026-08-22T03:04:05.000Z');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-download-router-'));
const projectRoot = path.join(fixtureRoot, 'project');
const obsidianVault = path.join(fixtureRoot, 'obsidian-vault');
const projectDirectories = {
  image: path.join(projectRoot, '创作资产库', '校园心动', '生成图片'),
  video: path.join(projectRoot, '素材库', '校园心动', '生成视频'),
  audio: path.join(projectRoot, '素材库', '校园心动', '音频'),
  downloads: path.join(projectRoot, '创作资产库', '校园心动', '浏览器下载'),
};

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertScoped(target, base, label) {
  assert.equal(isWithin(base, target.directory), true, `${label}目录越出剧本项目`);
  assert.equal(isWithin(base, target.targetPath), true, `${label}文件越出剧本项目`);
  assert.equal(isWithin(fixtureRoot, target.targetPath), true, `${label}文件越出测试临时根`);
}

async function main() {
try {

assert.equal(classifyDownload({ filename: 'shot.MP4' }), 'video');
assert.equal(classifyDownload({ filename: 'voice.bin', mimeType: 'audio/wav' }), 'audio');
assert.equal(classifyDownload({ filename: 'frame.webp' }), 'image');
assert.equal(classifyDownload({ filename: 'unknown.bin', mode: 'image' }), 'file');
assert.equal(classifyDownload({ filename: 'unknown.bin', mode: 'video', serviceId: 'updream' }), 'file');
assert.equal(classifyDownload({ filename: '剪映安装包.dmg', mimeType: 'application/octet-stream' }), 'file');

assert.equal(sanitizeFilename('../bad:<shot>?.mp4', fixedNow), 'bad__shot__.mp4');
assert.equal(sanitizeFilename('..\\bad:<shot>?.mp4', fixedNow), 'bad__shot__.mp4',
  '来自 Windows 的下载建议也必须先剥离路径再生成本机文件名');
assert.equal(sanitizeFilename('CON.png', fixedNow), '_CON.png');
assert.match(sanitizeFilename('', fixedNow), /^download-\d{14}$/);
const longName = `${'x'.repeat(210)}.png`;
const safeLongName = sanitizeFilename(longName, fixedNow);
assert.equal(safeLongName.length, 180);
assert.ok(safeLongName.endsWith('.png'), '长文件名必须保留扩展名');
const chineseLongName = sanitizeFilename(`${'镜'.repeat(100)}.mp4`, fixedNow);
assert.ok(Buffer.byteLength(chineseLongName, 'utf8') <= 240, '中文下载名必须低于跨平台文件名字节预算');
assert.ok(chineseLongName.endsWith('.mp4'), '中文长文件名必须保留扩展名');
const emojiLongName = sanitizeFilename(`${'🎬'.repeat(100)}.webm`, fixedNow);
assert.ok(Buffer.byteLength(emojiLongName, 'utf8') <= 240, 'emoji 下载名必须低于跨平台文件名字节预算');
assert.ok(emojiLongName.endsWith('.webm'), 'emoji 长文件名必须保留扩展名');
assert.equal(dateFolder(new Date(2026, 7, 22)), '2026-08-22');

const nativeShotPath = path.join(fixtureRoot, 'shot.mp4');
assert.equal(uniquePath(nativeShotPath, () => false), nativeShotPath);
const collision = uniquePath(nativeShotPath, candidate => !candidate.includes(' (3)'));
assert.equal(path.basename(collision), 'shot (3).mp4');
assert.equal(path.win32.basename('C:\\test-root\\shot (3).mp4'), 'shot (3).mp4',
  'Windows 路径语义必须由 path.win32 明确测试，而不是依赖当前主机');

const scopedImageTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'midjourney',
  serviceLabel: 'Midjourney',
  mode: 'image',
  filename: '../character.png',
  mimeType: 'image/png',
  projectDirectories,
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(scopedImageTarget.kind, 'image');
assert.equal(scopedImageTarget.isImage, true);
assert.equal(scopedImageTarget.projectScoped, true);
assert.equal(scopedImageTarget.directory, path.join(projectDirectories.image, 'Midjourney', '第1集'));
assert.equal(path.basename(scopedImageTarget.targetPath), 'character.png');
assertScoped(scopedImageTarget, projectDirectories.image, '图片下载');

const scopedVideoTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'updream',
  serviceLabel: 'Updream',
  mode: 'video',
  filename: 'scene.mp4',
  mimeType: 'video/mp4',
  projectDirectories,
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(scopedVideoTarget.kind, 'video');
assert.equal(scopedVideoTarget.isImage, false);
assert.equal(scopedVideoTarget.projectScoped, true);
assert.equal(scopedVideoTarget.directory, path.join(projectDirectories.video, 'Updream', '第1集'));
assertScoped(scopedVideoTarget, projectDirectories.video, '视频下载');

const scopedAudioTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'updream',
  serviceLabel: 'Updream',
  mode: 'video',
  filename: '人物对白.wav',
  mimeType: 'audio/wav',
  projectDirectories,
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(scopedAudioTarget.kind, 'audio');
assert.equal(scopedAudioTarget.isImage, false);
assert.equal(scopedAudioTarget.projectScoped, true);
assert.equal(scopedAudioTarget.directory, path.join(projectDirectories.audio, 'Updream', '第1集'));
assertScoped(scopedAudioTarget, projectDirectories.audio, '音频下载');

const scopedFileTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'gpt',
  serviceLabel: 'GPT',
  mode: 'video',
  filename: '剪映安装包.dmg',
  mimeType: 'application/octet-stream',
  projectDirectories,
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(scopedFileTarget.kind, 'file');
assert.equal(scopedFileTarget.isImage, false);
assert.equal(scopedFileTarget.projectScoped, true);
assert.equal(scopedFileTarget.directory, path.join(projectDirectories.downloads, 'GPT'));
assert.equal(path.basename(scopedFileTarget.targetPath), '剪映安装包.dmg');
assertScoped(scopedFileTarget, projectDirectories.downloads, '安装包下载');

const legacyFileTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'gpt',
  serviceLabel: 'GPT',
  mode: 'image',
  filename: '工具.zip',
  mimeType: 'application/zip',
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(legacyFileTarget.kind, 'file');
assert.equal(legacyFileTarget.directory, path.join(projectRoot, '素材库', '浏览器下载', 'GPT'));
assert.equal(isWithin(fixtureRoot, legacyFileTarget.targetPath), true, '旧安装包目标越出测试临时根');

const legacyImageTarget = resolveDownloadTarget({
  projectRoot,
  obsidianVault,
  serviceId: 'midjourney',
  serviceLabel: 'Midjourney',
  mode: 'image',
  filename: 'legacy-character.png',
  mimeType: 'image/png',
  now: new Date(2026, 7, 22),
  exists: () => false,
});
assert.equal(legacyImageTarget.projectScoped, false);
assert.equal(legacyImageTarget.directory, path.join(obsidianVault, 'ai创作短剧', '韩剧制作', '浏览器生成', 'Midjourney', '第1集'));

for (const legacy of [
  { filename: 'legacy-scene.mp4', mimeType: 'video/mp4', kind: 'video' },
  { filename: 'legacy-dialogue.wav', mimeType: 'audio/wav', kind: 'audio' },
]) {
  const target = resolveDownloadTarget({
    projectRoot,
    obsidianVault: '',
    serviceId: 'updream',
    serviceLabel: 'Updream',
    mode: 'video',
    filename: legacy.filename,
    mimeType: legacy.mimeType,
    now: new Date(2026, 7, 22),
    exists: () => false,
  });
  assert.equal(target.kind, legacy.kind);
  assert.equal(target.projectScoped, false);
  assert.equal(target.directory, path.join(projectRoot, '素材库', '浏览器生成', 'Updream', '第1集'));
  assert.equal(isWithin(fixtureRoot, target.targetPath), true, '旧调用目标越出测试临时根');
}

assert.throws(() => resolveDownloadTarget({
  projectRoot,
  obsidianVault: '',
  serviceId: 'gpt',
  serviceLabel: 'GPT',
  mode: 'image',
  filename: 'frame.png',
}), /图片归档目录/);

const libraryRoot = path.join(projectRoot, '创作资产库');
const selectedEpisode = path.join(libraryRoot, '校园心动/生成视频/核绘/第14集');
fs.mkdirSync(selectedEpisode, { recursive: true });
const selectedProject = { id: 'a', folder: '校园心动' };
assert.equal(resolveSelectedDownloadDirectory(libraryRoot, selectedProject, '校园心动/生成视频/核绘/第14集'), fs.realpathSync.native(selectedEpisode));
assert.equal(resolveSelectedDownloadDirectory(libraryRoot, selectedProject, ''), '');
assert.throws(() => resolveSelectedDownloadDirectory(libraryRoot, selectedProject, '其他剧本/第14集'), /不属于/);
assert.throws(() => resolveSelectedDownloadDirectory(libraryRoot, selectedProject, '校园心动/../别的剧本'), /不属于/);
for (const choice of ['editable', 'processing']) {
  const target = resolveDownloadTarget({ projectRoot, projectDirectories, filename: 'video.mp4', serviceId: 'hehui', serviceLabel: '核绘',
    episode: 60, selectedDirectory: selectedEpisode, videoDisposition: choice });
  assert.equal(target.directory, path.join(selectedEpisode, choice === 'editable' ? '可剪辑' : '待处理'));
  assert.ok(!target.directory.includes('第60集'));
}
const directStatus = path.join(selectedEpisode, '待处理'); fs.mkdirSync(directStatus);
assert.equal(resolveDownloadTarget({ projectRoot, projectDirectories, filename: 'video.mp4', episode: 60,
  selectedDirectory: directStatus, videoDisposition: 'editable' }).directory, directStatus, 'explicit status directory wins without nesting another status');
assert.equal(resolveDownloadTarget({ projectRoot, projectDirectories, filename: 'frame.png', episode: 60,
  selectedDirectory: selectedEpisode }).directory, selectedEpisode);
assert.equal(resolveDownloadTarget({ projectRoot, projectDirectories, filename: 'notes.txt',
  selectedDirectory: selectedEpisode }).directory, selectedEpisode);
const capturedDirectory = selectedEpisode;
assert.equal(resolveDownloadTarget({ projectRoot, projectDirectories, filename: 'video.mp4', episode: 60,
  selectedDirectory: capturedDirectory, videoDisposition: 'editable' }).directory,path.join(selectedEpisode,'可剪辑'));
console.log('CURRENT_DOWNLOAD_FOLDER_PASS explicit14Overrides60 status image document projectScope capturedTarget');
const downloadRoot = projectDirectories.downloads;
const generatedRoot = path.join(libraryRoot, '校园心动', '生成视频');
fs.mkdirSync(downloadRoot, { recursive: true });
fs.mkdirSync(generatedRoot, { recursive: true });
const archivePath = path.join(downloadRoot, '工具.zip');
const mediaPath = path.join(downloadRoot, '旧视频.mp4');
const outsidePath = path.join(generatedRoot, '说明.txt');
for (const file of [archivePath, mediaPath, outsidePath]) fs.writeFileSync(file, 'fixture');
const countBeforeDelete = buildCreativeAssetTree(libraryRoot, { scopePath: '校园心动/浏览器下载' }).stats.files;
await assert.rejects(deleteBrowserDownloadFile({ libraryRoot, downloadsRoot: downloadRoot, relativePath: '校园心动/生成视频/说明.txt' }), /只能永久删除/);
await assert.rejects(deleteBrowserDownloadFile({ libraryRoot, downloadsRoot: downloadRoot, relativePath: '校园心动/浏览器下载/旧视频.mp4' }), /不属于浏览器下载文件/);
assert.equal(fs.existsSync(outsidePath), true);
assert.equal(fs.existsSync(mediaPath), true);
await deleteBrowserDownloadFile({ libraryRoot, downloadsRoot: downloadRoot, relativePath: '校园心动/浏览器下载/工具.zip' });
assert.equal(fs.existsSync(archivePath), false, '永久删除后文件不得留在原目录');
assert.equal(buildCreativeAssetTree(libraryRoot, { scopePath: '校园心动/浏览器下载' }).stats.files, countBeforeDelete - 1, '扫描计数应只减掉实际删除的一个文件');
assert.equal(fs.existsSync(downloadRoot), true, '删除单个文件不得删除下载目录');

// Permanent downloads have a separate, monotonic, non-renewing five-minute grant.
let clock = 0, epoch = 0, alive = true, prompts = 0;
let consent = { approved: false, skipConfirmationForFiveMinutes: true };
const downloadContext = () => ({ projectId: 'fixture-a', folder: '校园心动', downloadsRoot: downloadRoot, epoch });
const removeDownload = createBrowserDownloadDeletion({ libraryRoot, getContext: downloadContext, now: () => clock });
const confirmDownload = async () => { prompts++; return consent; };
let fixtureIndex = 0;
const documentFixture = () => {
  const name = `免确认-${++fixtureIndex}.txt`;
  fs.writeFileSync(path.join(downloadRoot, name), 'only disposable fixture');
  return '校园心动/浏览器下载/' + name;
};
const removeFixture = name => removeDownload(name, { confirm: confirmDownload, isAlive: () => alive });
const cancelledDocument = documentFixture();
assert.equal(await removeFixture(cancelledDocument), false);
assert.ok(fs.existsSync(path.join(libraryRoot, cancelledDocument)), 'checked cancellation must keep file');
consent = { approved: true, skipConfirmationForFiveMinutes: false };
await removeFixture(documentFixture()); assert.equal(prompts, 2, 'cancel must not grant');
await removeFixture(documentFixture()); assert.equal(prompts, 3, 'unchecked confirmation must not grant');
consent = { approved: true, skipConfirmationForFiveMinutes: true };
clock = 100; await removeFixture(documentFixture()); assert.equal(prompts, 4);
clock = 299999; await removeFixture(documentFixture()); assert.equal(prompts, 4);
clock = 300100; await removeFixture(documentFixture()); assert.equal(prompts, 5, 'expires at exact boundary; previous deletes do not renew');
epoch++; await removeFixture(documentFixture()); assert.equal(prompts, 6, 'switch epoch revokes consent');
clock = -1; await removeFixture(documentFixture()); assert.equal(prompts, 7, 'backward clock requires confirmation');
alive = false;
await assert.rejects(removeFixture(documentFixture()), /窗口已切换/);
alive = true; epoch++;
const switched = documentFixture();
await assert.rejects(removeDownload(switched, { isAlive: () => true, confirm: async () => { epoch++; return consent; } }), /窗口已切换/);
assert.ok(fs.existsSync(path.join(libraryRoot, switched)));
const replaced = documentFixture();
await assert.rejects(removeDownload(replaced, { confirm: async () => {
  fs.writeFileSync(path.join(libraryRoot, replaced), 'replacement has a different size'); return consent;
} }), /文件已变更/);
await removeFixture(documentFixture()); assert.equal(prompts, 8, 'replaced file must not grant skip');
await assert.rejects(removeFixture('校园心动/生成视频/说明.txt'), /只能永久删除/);
await assert.rejects(removeFixture('校园心动/浏览器下载/旧视频.mp4'), /不属于浏览器下载文件/);
epoch++; let releaseDialog;
const held = removeDownload(documentFixture(), { confirm: () => new Promise(resolve => { releaseDialog = resolve; }) });
await assert.rejects(removeFixture(documentFixture()), /正在执行/);
releaseDialog({ approved: false }); assert.equal(await held, false);
console.log('DOWNLOAD_DELETE_CONSENT_PASS cancel default opt-in exact-expiry no-renewal project-switch clock window identity scope media concurrency');

for (const videoDisposition of ['editable', 'processing']) {
  const target = resolveDownloadTarget({ projectRoot, projectDirectories, serviceId: 'hehui', serviceLabel: '核绘',
    filename: '片段.mp4', mimeType: 'video/mp4', videoDisposition, episode: 12, platformFolder: '核绘', exists: () => false });
  assert.equal(target.directory, path.join(projectDirectories.video, '核绘', '第12集', videoDisposition === 'editable' ? '可剪辑' : '待处理'));
  assert.equal(target.episode, 12); assert.equal(target.episodeLabel, '第12集');
  const old = resolveDownloadTarget({ projectRoot, projectDirectories, serviceId: 'hehui', serviceLabel: '核绘',
    filename: '旧暂存片段.mp4', mimeType: 'video/mp4', videoDisposition, legacyDay: '2026-10-08', exists: () => false });
  assert.equal(old.directory, path.join(projectDirectories.video, videoDisposition === 'editable' ? '可剪辑' : '待处理', '核绘', '2026-10-08'));
  assert.equal(old.episode, null, '旧待审下载不能冒充第1集');
}
assert.throws(() => resolveDownloadTarget({ projectRoot, projectDirectories, filename: '片段.mp4', episode: 0 }), /集号/);
assert.throws(() => resolveDownloadTarget({ projectRoot, projectDirectories, filename: '片段.mp4', episode: 1.5 }), /集号/);
assert.throws(() => resolveDownloadTarget({ projectRoot, projectDirectories, filename: '片段.mp4', platformFolder: '../outside' }), /网站文件夹/);
assert.throws(() => resolveDownloadTarget({ projectRoot, projectDirectories, filename: '片段.mp4', legacyDay: '../outside' }), /旧下载日期/);

console.log('DOWNLOAD_ROUTER PASS: classification, sanitization, project-scoped media episodes, documents without dates and old pending-review compatibility');
} finally {
  const relative = path.relative(os.tmpdir(), fixtureRoot);
  assert.ok(relative.startsWith('video-os-download-router-') && !relative.includes(`..${path.sep}`), '拒绝清理非测试临时目录');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
