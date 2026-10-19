'use strict';
const assert = require('node:assert/strict');
const Layout = require('./assets/ui/generated-video-layout.js');
const Order = require('./assets/ui/asset-order.js');
const project = { id: 'fixture-project', folder: '隔离剧本', categories: [{ id: 'generated-videos', path: '隔离剧本/生成视频' }] };
const root = project.categories[0].path, site = root + '/核绘';
const batch = { projectId: project.id, states: [{ projectId: project.id, available: true, kind: 'video', platformFolder: '核绘', platformPath: site, episode: 2 }] };
const paths = [
  root + '/待处理/核绘/2026-09-10/旧待处理.mp4',
  root + '/可剪辑/核绘/2026-09-11/旧可剪辑.mp4',
  site + '/2026-09-12/原有视频.mp4',
  site + '/第1集/001.mp4',
  site + '/第2集/待处理/001.mp4',
  site + '/第2集/可剪辑/001.mp4',
  site + '/第10集/可剪辑/001.mp4',
];
function fixture(manifest = paths, empty = []) {
  const nodes = new Map();
  const ensure = key => {
    if (nodes.has(key)) return nodes.get(key);
    const index = key.lastIndexOf('/'), parent = index < 0 ? '' : key.slice(0, index);
    const folder = { node: { kind: 'folder', name: key.split('/').at(-1), path: key, fileCount: 0, children: [] }, depth: key.split('/').length - 1, parentPath: parent, hasChildren: true };
    nodes.set(key, folder); if (parent) ensure(parent);
    return folder;
  };
  const assets = manifest.map(token => {
    const folderPath = token.slice(0, token.lastIndexOf('/'));
    ensure(folderPath);
    let current = folderPath;
    while (current) { ensure(current).node.fileCount++; const index = current.lastIndexOf('/'); current = index < 0 ? '' : current.slice(0, index); }
    return { kind: 'file', type: 'video', path: token, folderPath, name: token.split('/').at(-1), size: 17 };
  });
  empty.forEach(ensure);
  return { folders: [...nodes.values()], assets, project, batch };
}
function run() {
  const input = fixture(paths, [site + '/第3集', root + '/可剪辑']);
  const original = JSON.stringify(input), output = Layout.organize(input);
  assert.equal(JSON.stringify(input), original, 'Projection must never mutate source tree/assets/config');
  assert.deepEqual(output.assets.map(file => [file.path, file.folderPath, file.size]), input.assets.map(file => [file.path, file.folderPath, file.size]));
  assert.equal(output.folders.filter(folder => folder.node.name === '核绘').length, 1, 'One website across old/new layouts');
  assert.deepEqual(output.folders.filter(folder => folder.parentPath === root).map(folder => folder.node.name), ['核绘']);
  assert.equal(output.members.get(site).size, 7);
  const siteChildren = Order.orderFolders(output.folders.filter(folder => folder.parentPath === site), [site + '/第10集']);
  assert.deepEqual(siteChildren.map(folder => folder.node.name), ['第1集', '第2集', '第3集', '第10集', '未分集素材']);
  const history = output.folders.find(folder => folder.virtualHistory);
  assert.equal(history.node.fileCount, 3); assert.equal(history.parentPath, site);
  assert.deepEqual(Order.orderFolders(output.folders.filter(folder => folder.parentPath === history.node.path)).map(folder => folder.node.name), ['可剪辑', '待处理']);
  assert.equal(output.folders.filter(folder => folder.node.name === '待处理').length, 2);
  const direct = new Set();
  for (const folder of output.folders.filter(folder => folder.generatedVideoGroup)) {
    for (const asset of output.assets.filter(file => file.displayFolderPath === folder.node.path)) {
      assert.equal(direct.has(asset.path), false, 'Each file has exactly one leaf/card'); direct.add(asset.path);
    }
    if (folder.virtualGenerated) assert.ok(Layout.isVirtualPath(folder.node.path));
  }
  assert.equal(direct.size, paths.length);
  assert.equal(output.folders.find(folder => folder.node.path === site).composite, true);
  assert.equal(output.aliases.get(site), site, 'Real websites never alias to a direct-file leaf');
  assert.equal(output.aliases.get(site + '/第1集'), site + '/第1集', 'Real episodes keep their browse/import identity');
  assert.equal(output.folders.find(folder => folder.node.path === site).actionPath, site);
  assert.deepEqual(output.folders.find(folder => folder.node.path === site).capabilities, { create: true, reveal: true, rename: true, delete: false });
  assert.deepEqual(output.folders.find(folder => folder.node.path === site).backingPaths.sort(), [site, root + '/待处理/核绘', root + '/可剪辑/核绘'].sort());
  assert.equal(output.aliases.get(root + '/待处理'), root);
  assert.ok(output.aliases.get(site + '/2026-09-12'));
  const renamedInput = fixture(paths.map(token => token.startsWith(site + '/') ? token.replace(site + '/', root + '/核绘站点/') : token));
  renamedInput.batch = { projectId: project.id, states: [{ ...batch.states[0], platformFolder: '核绘站点', platformPath: root + '/核绘站点', serviceLabel: '核绘' }] };
  const renamed = Layout.organize(renamedInput);
  assert.deepEqual(renamed.folders.filter(folder => folder.parentPath === root).map(folder => folder.node.name), ['核绘站点'], 'An explicit website rename must still incorporate its original legacy status branches');
  assert.equal(renamed.members.get(root + '/核绘站点').size, 7);
  const emptyStatus = Layout.organize(fixture([site + '/第1集/待处理/001.mp4'], [root + '/可剪辑', root + '/待处理', site + '/第1集/可剪辑']));
  assert.deepEqual(emptyStatus.folders.filter(folder => folder.parentPath === root).map(folder => folder.node.name), ['核绘']);
  assert.deepEqual(Order.orderFolders(emptyStatus.folders.filter(folder => folder.parentPath === site + '/第1集')).map(folder => folder.node.name), ['可剪辑', '待处理'], 'Existing real empty destinations remain usable, not invented');
  const noInvented = Layout.organize(fixture([site + '/第1集/待处理/001.mp4']));
  assert.deepEqual(noInvented.folders.filter(folder => folder.parentPath === site + '/第1集').map(folder => folder.node.name), ['待处理']);
  const custom = root + '/待处理/用户自建/2026-09-01/自建.mp4';
  const customOutput = Layout.organize(fixture([...paths, custom]));
  assert.ok(customOutput.folders.some(folder => folder.node.path === root + '/待处理/用户自建'));
  assert.ok(customOutput.assets.some(file => file.path === custom && !file.displayFolderPath));
  const nestedPath = site + '/2026-09-12/用户自建';
  const nested = Layout.organize(fixture([nestedPath + '/自建.mp4'], [site + '/空的自建文件夹']));
  assert.equal(nested.folders.find(folder => folder.node.path === nestedPath).virtualGenerated, false, 'Unique real custom folders remain real menu/import targets');
  assert.ok(nested.folders.some(folder => folder.node.path === site + '/空的自建文件夹'));
  for (const target of [site + '/第1集/待处理/空自建', site + '/2026-09-12/空自建', root + '/待处理/核绘/2026-09-12/空自建']) {
    const emptyCustom = Layout.organize(fixture([], [target]));
    const displayed = emptyCustom.folders.find(folder => folder.node.path === target);
    assert.ok(displayed, 'Actual empty custom directories survive episode/status/date wrappers: ' + target);
    assert.equal(displayed.actionPath, target); assert.equal(displayed.virtualGenerated, false);
  }
  const mixed = fixture([site + '/第1集/本地.mp4', site + '/第1集/待处理/下载.mp4']);
  mixed.assets[0].videoDisposition = 'editable'; mixed.assets[1].videoDisposition = 'processing';
  const stable = Layout.organize(mixed);
  assert.equal(stable.aliases.get(site + '/第1集'), site + '/第1集');
  assert.equal(stable.members.get(stable.aliases.get(site + '/第1集')).size, 2, 'Refresh does not narrow whole-episode scope');
  const loose = Layout.organize(fixture([site + '/新导入.mp4']));
  assert.equal(loose.aliases.get(site), site);
  assert.ok(loose.folders.some(folder => folder.node.name === '未分集素材'));
  assert.equal(loose.folders.some(folder => folder.node.name === '未分集历史素材'), false);
  const oldVirtual = 'videoOS-generated://' + encodeURIComponent(site + '/未分集历史素材/可剪辑');
  assert.equal(loose.aliases.get(oldVirtual), loose.assets[0].displayFolderPath, 'Saved legacy aggregate selection remains recoverable');
  const legacyEpisodePath = root + '/待处理/核绘/第1集/既有.mp4';
  const legacyOnly = Layout.organize(fixture([legacyEpisodePath]));
  const becamePhysical = Layout.organize(fixture([legacyEpisodePath], [site + '/第1集/待处理']));
  for (const conceptual of [site, site + '/第1集', site + '/第1集/待处理']) {
    const oldKey = 'videoOS-generated://' + encodeURIComponent(conceptual);
    assert.ok(legacyOnly.folders.some(folder => folder.node.path === oldKey && folder.virtualGenerated));
    assert.equal(becamePhysical.aliases.get(oldKey), conceptual,
      'Virtual website/episode/status identity remains the same scope after its physical directory appears');
    assert.equal(becamePhysical.members.get(conceptual).size, 1);
    assert.equal(becamePhysical.aliases.get(conceptual), conceptual, 'Parent aliases cannot be overwritten by their leaves');
  }
  assert.deepEqual(becamePhysical.assets.map(file => [file.path, file.folderPath]), legacyOnly.assets.map(file => [file.path, file.folderPath]),
    'Creating canonical directories never guesses or moves legacy episode files');
  const collisions = Layout.organize(fixture([nestedPath + '/一.mp4', site + '/2026-09-13/用户自建/二.mp4']));
  assert.equal(collisions.folders.find(folder => folder.node.name === '用户自建').virtualGenerated, true, 'Merged same-name directories cannot impersonate one physical write target');
  for (const modified of [undefined, { ...batch, projectId: 'another' }, { ...batch, states: [] }, { ...batch, states: [{ ...batch.states[0], available: false }] }, { ...batch, states: [null, { ...batch.states[0], platformFolder: '../核绘' }] }]) {
    const guarded = Layout.organize({ ...input, batch: modified });
    assert.deepEqual(guarded.folders.map(folder => [folder.node.path, folder.parentPath]), input.folders.map(folder => [folder.node.path, folder.parentPath]));
    assert.deepEqual(guarded.assets, input.assets);
  }
  const unidentified = Layout.organize({ ...fixture([root + '/未知站点/第1集/一.mp4']), batch: { projectId: project.id, states: [] } });
  assert.ok(unidentified.folders.find(folder => folder.node.path === root + '/未知站点').archiveUnclassified);
  const large = fixture(Array.from({ length: 10000 }, (_, index) => site + '/第2集/待处理/' + index + '.mp4'));
  const start = performance.now(), largeOutput = Layout.organize(large), elapsed = performance.now() - start;
  assert.equal(largeOutput.members.get(site).size, 10000);
  assert.ok(elapsed < 1500, '10000-asset projection must remain bounded');
  console.log('GENERATED_VIDEO_LAYOUT_PASS files=7 websites=1 counts=unique originals=preserved invalidMetadata=guarded largeMs=' + elapsed.toFixed(1));
}
if (require.main === module) run();
module.exports = { fixture, project, batch, paths, root, site };
