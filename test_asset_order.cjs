'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Order = require('./assets/ui/asset-order.js');
const { buildCreativeAssetTree } = require('./creative-assets.cjs');

const dates = ['2026-09-10', '2026-09-11', '2026-09-18', '2026-09-28', '2026-10-07', '2026-10-08'];
const expected = [...dates].reverse();
const folder = name => ({ node: { name, path: `核绘/${name}` } });
const ascending = dates.map(folder);
const oldSaved = dates.slice(0, 4).map(date => `核绘/${date}`);
assert.deepEqual(Order.orderFolders(ascending, oldSaved).map(item => item.node.name), expected);
assert.deepEqual(ascending.map(item => item.node.name), dates, '不得改变源数组');
assert.deepEqual(Order.orderFolders(ascending, [...oldSaved].reverse()).map(item => item.node.name), expected);
assert.deepEqual(Order.orderFolders(ascending, ['已删除', '核绘/2026-09-18', '核绘/2026-09-18']).map(item => item.node.name), expected);
const mixed = [folder('场景资产'), folder('2026-09-10'), folder('人物资产'), folder('2026-10-08')];
assert.deepEqual(Order.orderFolders(mixed, ['核绘/人物资产', '核绘/2026-09-10', '核绘/场景资产']).map(item => item.node.name),
  ['人物资产', '2026-10-08', '场景资产', '2026-09-10'], '普通分类保留手动顺序，日期槽位保持倒序');
const episodes = ['第10集', '第2集', '第1集', '第99集'];
assert.deepEqual(Order.orderFolders(episodes.map(folder), episodes.map(name => `核绘/${name}`)).map(item => item.node.name),
  ['第1集', '第2集', '第10集', '第99集'], '分集按数字排列，不沿用旧手动顺序');
assert.deepEqual(episodes.map(name => `核绘/${name}/可剪辑`).sort(Order.compareFolderPaths),
  ['第1集', '第2集', '第10集', '第99集'].map(name => `核绘/${name}/可剪辑`));
for (const invalid of ['第0集', '第01集', '第1000000集', '第一集', '第2集参考']) assert.equal(Order.episodeFolderKey(invalid), 0);
assert.equal(Order.dateFolderKey('2024-02-29'), '2024-02-29');
for (const invalid of ['2026-02-29', '2026-13-01', '2026-09-00', '2026-9-1', '视频2026-10-08', '2026-10-08.mp4']) {
  assert.equal(Order.dateFolderKey(invalid), '', invalid);
}
assert.equal(Order.directoryDate('生成视频\\2026-09-10\\核绘\\2026-10-08'), '2026-10-08');
assert.equal(Order.assetDateKey({ path: '核绘/2026-09-18/视频-2026-10-08.mp4', mtime: '2026-10-08T06:00:00Z' }), '2026-09-18');
assert.equal(Order.assetDateKey({ relativePath: '核绘/2026-10-07/视频.mp4', path: '@media:opaque', mtime: '2026-09-10T06:00:00Z' }), '2026-10-07');
process.env.TZ = 'Asia/Taipei';
assert.equal(Order.assetDateKey({ path: '音频/音色.wav', mtime: '2026-10-07T16:30:00Z' }), '2026-10-08', '无日期目录按本地日期');
const files = [
  { name: '视频-100.mp4', path: '核绘/2026-09-18/视频-100.mp4', mtime: '2026-10-08T06:00:00Z' },
  { name: '视频-002.mp4', path: '核绘/2026-10-08/视频-002.mp4', mtime: '2026-10-08T01:00:00Z' },
  { name: '视频-003.mp4', path: '核绘/2026-10-08/视频-003.mp4', mtime: '2026-10-08T03:00:00Z' },
  { name: '视频-004.mp4', path: '核绘/2026-10-08/视频-004.mp4', mtime: '2026-10-08T03:00:00Z' },
];
assert.deepEqual([...files].sort(Order.newestFirst).map(item => item.name), ['视频-004.mp4', '视频-003.mp4', '视频-002.mp4', '视频-100.mp4']);
assert.deepEqual(dates.map(date => `核绘/${date}`).sort(Order.compareFolderPaths), expected.map(date => `核绘/${date}`));
assert.deepEqual(['核绘/2026-09-10', '核绘/2026-09-15说明', '核绘/2026-10-08'].sort(Order.compareFolderPaths),
  ['核绘/2026-10-08', '核绘/2026-09-10', '核绘/2026-09-15说明'], '混合目录比较需保持可传递');

// 真实文件系统扫描：日期目录倒序、同日文件倒序、读取不改动路径或内容。
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-date-order-')));
try {
  const root = path.join(temp, '创作资产库');
  for (const date of dates) {
    const dir = path.join(root, '剧本', '生成视频', '核绘', date);
    fs.mkdirSync(dir, { recursive: true });
    for (const sequence of ['001', '002']) {
      const target = path.join(dir, `视频-${sequence}.mp4`);
      fs.writeFileSync(target, 'order-test');
      const time = new Date(`${date}T0${sequence === '002' ? '9' : '8'}:00:00Z`);
      fs.utimesSync(target, time, time);
    }
  }
  const scan = buildCreativeAssetTree(root, { scopePath: '剧本/生成视频/核绘' });
  assert.equal(scan.stats.video, dates.length * 2);
  assert.deepEqual(scan.tree.children.map(item => item.name), expected);
  for (const child of scan.tree.children) {
    assert.deepEqual(child.children.map(item => item.name), ['视频-002.mp4', '视频-001.mp4']);
    for (const file of child.children) assert.equal(fs.readFileSync(path.join(root, file.path), 'utf8'), 'order-test');
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('ASSET_ORDER_UNIT_PASS: legacy ranks, mixed folders, local dates, file ties, filesystem scan');
