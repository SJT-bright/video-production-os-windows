'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDownloadReview } = require('./electron/download-review.cjs');
const { resolveDownloadTarget } = require('./electron/download-router.cjs');
const { createCreativeProjectStore } = require('./creative-projects.cjs');
const { createFloatPresentation } = require('./electron/float-presentation.cjs');
const VideoDisposition = require('./assets/ui/video-disposition.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-review-'));
  try {
    const assets = path.join(root, 'assets'), data = path.join(root, 'data');
    fs.mkdirSync(assets); fs.mkdirSync(data);
    const store = createCreativeProjectStore({ assetRoot: assets, filePath: path.join(data, 'projects.json') });
    const a = store.create({ name: '下载剧本甲' }), b = store.create({ name: '下载剧本乙' });
    const targetFor = entry => resolveDownloadTarget({ projectRoot: root, filename: entry.filename, mimeType: 'video/mp4',
      serviceId: entry.serviceId, serviceLabel: entry.serviceLabel, videoDisposition: entry.choice,
      projectDirectories: { video: store.category(entry.projectId, 'generated-videos').absolutePath }, now: new Date(`${entry.day}T12:00:00`) }).targetPath;
    const validateTarget = (entry, destination) => {
      const base = path.join(store.category(entry.projectId, 'generated-videos').absolutePath, entry.choice === 'processing' ? '待处理' : '可剪辑');
      const relative = path.relative(base, destination);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    };
    let review = createDownloadReview({ dataDir: data, targetFor, validateTarget });
    const begin = (id, filename = '生成.mp4') => review.begin({ id, projectId: a.id, serviceId: 'hehui', serviceLabel: '核绘', filename,
      startedAt: '2026-10-08T01:00:00Z', day: '2026-10-08', productionSnapshot: { projectId: a.id } });
    const first = begin('dl-first');
    fs.writeFileSync(first.stagePath, 'complete video');
    assert.equal(fs.existsSync(targetFor({ ...first, choice: 'editable' })), false, '下载完成前不能进入资产树');
    await assert.rejects(review.finalize(first.id), /未选择|未下载/);
    review.complete(first.id);
    await assert.rejects(review.finalize(first.id), /未选择/);
    review.choose(first.id, 'processing');
    store.activate(b.id);
    const pending = await review.finalize(first.id);
    assert.ok(pending.path.split(path.sep).join('/').includes('下载剧本甲/生成视频/待处理/核绘/素材001/'));
    assert.equal(fs.readFileSync(pending.path, 'utf8'), 'complete video');
    assert.equal(VideoDisposition.of({ path: path.relative(assets, pending.path) }), 'processing');
    assert.equal(review.list().length, 0);

    const batch = ['dl-second', 'dl-third'].map(id => begin(id));
    for (const entry of batch) { fs.writeFileSync(entry.stagePath, entry.id); review.choose(entry.id, 'editable'); review.complete(entry.id); }
    const complete = await Promise.all(batch.map(entry => review.finalize(entry.id)));
    assert.notEqual(complete[0].path, complete[1].path, '同时下载同名视频不能覆盖');
    assert.equal(VideoDisposition.of({ path: pending.path.replace('待处理', '可剪辑') }), 'editable');
    assert.equal(VideoDisposition.of({ path: '下载剧本甲/生成视频/核绘/2026-09-18/原视频.mp4' }), 'editable', '旧文件不迁移，兼容可剪辑');
    assert.throws(() => review.choose('missing', 'editable'), /不存在/);
    const cancel = begin('dl-cancel'); fs.writeFileSync(cancel.stagePath, 'partial');
    await review.discard(cancel.id); assert.equal(fs.existsSync(cancel.stagePath), false);

    const restart = begin('dl-restart'); fs.writeFileSync(restart.stagePath, 'restart video'); review.complete(restart.id);
    review = createDownloadReview({ dataDir: data, targetFor, validateTarget });
    assert.equal(review.list()[0].completed, true);
    review.choose(restart.id, 'editable');
    // 模拟退出发生在硬链接后、日志最终标记前：重启必须识别相同文件而非复制另一份。
    const expected = targetFor(review.list()[0]); fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.linkSync(restart.stagePath, expected);
    const journal = path.join(data, 'video-download-review', 'reviews.json');
    const saved = JSON.parse(fs.readFileSync(journal)); saved.entries[restart.id].finalPath = expected;
    fs.writeFileSync(journal, JSON.stringify(saved));
    review = createDownloadReview({ dataDir: data, targetFor, validateTarget });
    assert.equal((await review.finalize(restart.id)).path, expected); assert.equal(review.list().length, 0);

    // 删除默认分类 + 后续扫描/重新激活/重启不得自动重建；失败必须回滚删除标记。
    const folder = store.category(a.id, 'characters'); fs.writeFileSync(path.join(folder.absolutePath, '原文件.txt'), 'keep');
    await assert.rejects(store.deleteFolder(a.id, folder.path, async () => { throw new Error('trash failure'); }), /trash failure/);
    assert.deepEqual(store.get(a.id).deletedFolders || [], []);
    const trash = path.join(root, 'isolated-trash'); fs.mkdirSync(trash);
    await store.deleteFolder(a.id, folder.path, absolute => fs.promises.rename(absolute, path.join(trash, '人物资产')));
    store.list(); store.activate(a.id); store.resolveRoot(a.id);
    const reopened = createCreativeProjectStore({ assetRoot: assets, filePath: path.join(data, 'projects.json') });
    assert.equal(fs.existsSync(folder.absolutePath), false);
    assert.equal(fs.readFileSync(path.join(trash, '人物资产', '原文件.txt'), 'utf8'), 'keep');
    await assert.rejects(reopened.deleteFolder(a.id, a.folder, () => {}), /不能删除整个剧本/);
    await assert.rejects(reopened.deleteFolder(a.id, `${b.folder}/人物资产`, () => {}), /当前剧本/);
    await assert.rejects(reopened.deleteFolder(a.id, '../outside', () => {}), /当前剧本/);
    const frames = reopened.category(a.id, 'frames');
    await reopened.deleteFolder(a.id, `${frames.path}/首帧`, absolute => fs.promises.rename(absolute, path.join(trash, '首帧')));
    reopened.list(); assert.equal(fs.existsSync(path.join(frames.absolutePath, '首帧')), false);
    assert.equal(fs.existsSync(path.join(frames.absolutePath, '尾帧')), true);

    const target = { x: 600, y: 300, width: 384, height: 336 };
    const source = { x: 100, y: 170, width: 100, height: 140 };
    const motion = createFloatPresentation(target, source, 'test');
    assert.deepEqual(motion.bounds, { x: 100, y: 170, width: 884, height: 466 });
    assert.equal(motion.render.left + motion.render.dx, 0);
    assert.equal(motion.render.top + motion.render.dy, 0);
    assert.equal(motion.render.scaleX * target.width, source.width);
    assert.equal(createFloatPresentation(target, { ...source, x: NaN }, 'test').render.anchored, false);
    console.log('DOWNLOAD_REVIEW_FOLDER_DELETE_MOTION_PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
