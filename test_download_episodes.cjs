'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDownloadEpisodeStore, episodeLabel, normalizeSnapshot } = require('./electron/download-episodes.cjs');
const { createDownloadReview } = require('./electron/download-review.cjs');
const { resolveDownloadTarget } = require('./electron/download-router.cjs');
const VideoDisposition = require('./assets/ui/video-disposition.js');

async function main() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-download-episodes-'));
  try {
    const data = path.join(root, 'data'), filePath = path.join(data, 'download-episodes.json');
    const scope = { projectId: 'project-a', serviceId: 'hehui', kind: 'video', serviceLabel: '核绘' };
    let store = createDownloadEpisodeStore({ filePath });
    const directoryFor = snapshot => path.join(root, 'assets', snapshot.projectId, snapshot.kind, snapshot.platformFolder, episodeLabel(snapshot.episode));
    const folderOperations = {
      exists: snapshot => fs.existsSync(directoryFor(snapshot)),
      create: snapshot => fs.mkdirSync(directoryFor(snapshot), { recursive: true }),
    };
    assert.equal(store.get(scope).episode, 1);
    assert.equal(fs.existsSync(filePath), false, '渲染默认状态不能写注册表');
    assert.equal(fs.existsSync(directoryFor(store.get(scope))), false, '只读取状态不能新建空文件夹');
    const original = store.capture(scope);
    assert.equal(Object.isFrozen(original), true);
    assert.equal(original.platformFolder, '核绘');
    assert.equal(store.capture({ ...scope, serviceLabel: '临时标签改名' }).platformFolder, '核绘', '改标签名不能分出新网站根');
    assert.equal(store.advance({ ...scope, expectedEpisode: 1 }, folderOperations).state.episode, 2);
    assert.equal(original.episode, 1, '进行中的下载快照不能跟着循环按钮修改');
    assert.equal(store.advance({ ...scope, expectedEpisode: 1 }, folderOperations).advanced, false, '相同点击重试不能跳两集');
    for (const different of [{ projectId: 'project-b' }, { serviceId: 'gpt', serviceLabel: 'GPT' }, { kind: 'image' }, { kind: 'audio' }]) {
      assert.equal(store.get({ ...scope, ...different }).episode, 1, '剧本/网站/媒体类型必须独立');
    }
    store = createDownloadEpisodeStore({ filePath });
    assert.equal(store.get(scope).episode, 2, '重启必须恢复当前集');
    const occupied = directoryFor({ ...original, episode: 3 });
    fs.mkdirSync(occupied, { recursive: true });
    const occupiedAsset = path.join(occupied, '原视频.mp4'); fs.writeFileSync(occupiedAsset, 'original');
    const dated = path.join(path.dirname(occupied), '2026-10-08'); fs.mkdirSync(dated); fs.writeFileSync(path.join(dated, '旧.mp4'), 'legacy');
    assert.equal(store.advance({ ...scope, expectedEpisode: 2 }, folderOperations).state.episode, 3, '已有合法下一集要复用，不能跳号');
    assert.equal(fs.readFileSync(occupiedAsset, 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(dated, '旧.mp4'), 'utf8'), 'legacy', '旧日期目录不搬移或乱分集');
    const emptyExisting = directoryFor({ ...original, episode: 4 }); fs.mkdirSync(emptyExisting);
    assert.equal(store.advance({ ...scope, expectedEpisode: 3 }, folderOperations).state.episode, 4, '已有空文件夹应复用，并保留从第一集依次增加的顺序');
    assert.throws(() => store.advance({ ...scope, expectedEpisode: 4 }, { ...folderOperations, create() { throw new Error('fixture directory unavailable'); } }), /unavailable/);
    assert.equal(store.get(scope).episode, 4, '新建文件夹失败不能更新当前集');
    assert.throws(() => normalizeSnapshot({ ...original, episode: 0 }), /集号/);
    assert.throws(() => normalizeSnapshot({ ...original, platformFolder: '../escape' }), /网站文件夹/);
    const collided = store.capture({ ...scope, serviceId: 'custom-different', serviceLabel: '核绘' });
    assert.notEqual(collided.platformFolder, original.platformFolder, '不同站点不能共享相同归档根');

    const categoryFor = projectId => path.join(root, 'assets', projectId, '生成视频');
    const targetFor = entry => resolveDownloadTarget({ projectRoot: root, projectDirectories: { video: categoryFor(entry.projectId) },
      serviceId: entry.serviceId, serviceLabel: entry.serviceLabel, filename: entry.filename, mimeType: 'video/mp4', videoDisposition: entry.choice,
      ...(entry.episodeSnapshot ? { episode: entry.episodeSnapshot.episode, platformFolder: store.get(entry.episodeSnapshot).platformFolder } : { legacyDay: entry.day }) }).targetPath;
    const validateTarget = (entry, target) => {
      const relative = path.relative(categoryFor(entry.projectId), target);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    };
    let review = createDownloadReview({ dataDir: data, targetFor, validateTarget });
    const begin = (id, episodeSnapshot = original) => review.begin({ id, projectId: episodeSnapshot.projectId,
      serviceId: episodeSnapshot.serviceId, serviceLabel: '核绘', filename: '同名.mp4', episodeSnapshot,
      startedAt: '2026-10-11T00:00:00Z', productionSnapshot: { projectId: episodeSnapshot.projectId } });
    const ongoing = [begin('dl-a'), begin('dl-b')];
    assert.equal(review.list().every(entry => entry.episodeSnapshot.episode === 1 && !Object.hasOwn(entry, 'day')), true);
    const downloaded = ongoing.map(entry => { fs.writeFileSync(entry.stagePath, entry.id); review.complete(entry.id); return entry; });
    store.advance({ ...scope, expectedEpisode: 4 }, folderOperations);
    review.choose(downloaded[0].id, 'editable'); review.choose(downloaded[1].id, 'processing');
    const results = await Promise.all(downloaded.map(entry => review.finalize(entry.id)));
    assert.equal(path.dirname(results[0].path), path.join(categoryFor('project-a'), '核绘', '第1集', '可剪辑'));
    assert.equal(path.dirname(results[1].path), path.join(categoryFor('project-a'), '核绘', '第1集', '待处理'));
    assert.equal(VideoDisposition.of({ path: results[1].path }), 'processing');
    assert.equal(VideoDisposition.of({ path: '剧本/生成视频/待处理/核绘/2026-09-18/旧视频.mp4' }), 'processing');
    results.forEach((result, index) => assert.equal(fs.readFileSync(result.path, 'utf8'), downloaded[index].id));

    const beforeRename = begin('dl-rename'); fs.writeFileSync(beforeRename.stagePath, 'rename snapshot'); review.complete(beforeRename.id);
    const renameScope = { ...scope, platformFolder: original.platformFolder };
    store.renamePlatform(renameScope, '核绘站点');
    assert.equal(store.get(scope).episode, 5, '改网站目录名不能更改当前集');
    assert.equal(store.get(scope).platformFolder, '核绘站点');
    assert.equal(original.platformFolder, '核绘', '下载开始时的原始快照保持不变');
    review.choose(beforeRename.id, 'editable');
    const renamedPending = await review.finalize(beforeRename.id);
    assert.equal(path.dirname(renamedPending.path), path.join(categoryFor('project-a'), '核绘站点', '第1集', '可剪辑'), '已知目录改名沿用同一网站身份，不返回旧目录，也不改为当前第5集');
    store = createDownloadEpisodeStore({ filePath });
    assert.equal(store.get(scope).platformFolder, '核绘站点', '重启后继续使用改名网站目录');

    const restart = begin('dl-restart', store.capture({ ...scope, projectId: 'project-b' }));
    fs.writeFileSync(restart.stagePath, 'restart'); review.complete(restart.id);
    store.advance({ ...scope, projectId: 'project-b', expectedEpisode: 1 }, folderOperations);
    review = createDownloadReview({ dataDir: data, targetFor, validateTarget });
    assert.equal(review.list()[0].episodeSnapshot.episode, 1);
    review.choose(restart.id, 'editable');
    const restored = await review.finalize(restart.id);
    assert.equal(path.dirname(restored.path), path.join(categoryFor('project-b'), '核绘', '第1集', '可剪辑'), '重启后分类不能用当前第2集代替原快照');
    assert.equal(fs.readFileSync(restored.path, 'utf8'), 'restart');

    const old = review.begin({ id: 'dl-legacy', projectId: 'project-a', serviceId: 'hehui', serviceLabel: '核绘',
      filename: '旧待审.mp4', day: '2026-10-08', startedAt: '2026-10-08T00:00:00Z' });
    fs.writeFileSync(old.stagePath, 'old pending'); review.complete(old.id); review.choose(old.id, 'processing');
    assert.equal(path.dirname((await review.finalize(old.id)).path), path.join(categoryFor('project-a'), '待处理', '核绘', '2026-10-08'), '旧待审记录仍回原日期目标，不冒认任何新集');
    assert.throws(() => review.begin({ id: 'dl-mismatch', projectId: 'project-b', serviceId: 'hehui',
      filename: '错误.mp4', episodeSnapshot: original }), /不一致/);
    assert.equal(review.list().length, 0);
    console.log('DOWNLOAD_EPISODES_PASS defaults/read-only rendering/stable sites/isolated scopes/persistence/reuse existing/site rename/concurrent snapshots/restart/legacy pending');
  } finally {
    assert.ok(path.basename(root).startsWith('video-os-download-episodes-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
