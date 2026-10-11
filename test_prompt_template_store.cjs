'use strict';
const assert = require('node:assert/strict');
const { create, GLOBAL_KEY, PROJECT_PREFIX } = require('./assets/ui/prompt-template-store.js');
class Storage {
  map = new Map(); blocked = '';
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { if (key === this.blocked) throw new Error('QuotaExceededError'); this.map.set(key, value); }
}
const template = (id, title, body) => ({ id, title, body, at: 42 });
const s = new Storage(), store = create(s);
const put = (id, value) => s.setItem(PROJECT_PREFIX + id, JSON.stringify(value));
const get = id => JSON.parse(s.getItem(PROJECT_PREFIX + id));
s.setItem(GLOBAL_KEY, JSON.stringify({ services: { video: 'gpt' }, templates: { image: [template('old', '通用', '原全局')], video: [] } }));
put('alpha', { prompts: { image: '原草稿' }, promptTemplates: { image: [template('own', '独立', '本剧旧模板')], video: [] } });
store.claimLegacy('alpha');
assert.deepEqual(store.load('alpha').image.map(item => item.body), ['本剧旧模板', '原全局']);
store.claimLegacy('beta');
assert.equal(store.load('beta').image.length, 0, '新剧本不能自动继承旧全局模板');
assert.equal(JSON.parse(s.getItem(GLOBAL_KEY)).templates.image[0].body, '原全局');
put('alpha', { promptTemplatesVersion: 3, promptTemplates: {
  image: [template('a1', '独立', '本剧旧模板'), template('a2', '通用', '新内容')], video: [template('av', '视频', '视频正文')],
}, prompts: { image: '来源草稿' }, scripts: { groups: ['甲剧本'] } });
const sourceBefore = s.getItem(PROJECT_PREFIX + 'alpha');
put('beta', { promptTemplatesVersion: 3, promptTemplates: {
  image: [template('b1', '通用', '目标原内容')], video: [],
}, prompts: { image: '目标草稿', video: '目标视频草稿' }, scripts: { groups: ['乙剧本'] }, history: { image: [{ body: '历史' }] }, custom: 123 });
const moved = store.migrate('alpha', 'beta');
assert.equal(moved.added, 3);
assert.equal(moved.counts.image, 2); assert.equal(moved.counts.video, 1);
assert.deepEqual(get('beta').promptTemplates.image.map(item => [item.title, item.body]), [
  ['通用', '目标原内容'], ['独立', '本剧旧模板'], ['通用（2）', '新内容'],
]);
assert.equal(get('beta').promptTemplates.image[0].id, 'b1');
assert.notEqual(get('beta').promptTemplates.image[1].id, 'a1');
assert.equal(s.getItem(PROJECT_PREFIX + 'alpha'), sourceBefore, '来源不能被删除或改写');
assert.deepEqual(get('beta').prompts, { image: '目标草稿', video: '目标视频草稿' });
assert.deepEqual(get('beta').scripts, { groups: ['乙剧本'] }); assert.equal(get('beta').custom, 123);
const targetBeforeRepeat = s.getItem(PROJECT_PREFIX + 'beta');
assert.equal(store.migrate('alpha', 'beta').added, 0, '同名改名后的副本也不能重复迁移');
assert.equal(s.getItem(PROJECT_PREFIX + 'beta'), targetBeforeRepeat);
const betaEdited = get('beta'); betaEdited.promptTemplates.image[1].body = '只改目标'; put('beta', betaEdited);
assert.equal(store.load('alpha').image[0].body, '本剧旧模板', '两份模板需要独立编辑');
put('alpha', { promptTemplatesVersion: 3, promptTemplates: { image: [], video: [] } });
assert.equal(store.load('alpha').image.length, 0, '删除后不能从旧全局模板复活');
put('large', { promptTemplatesVersion: 3, promptTemplates: {
  image: Array.from({ length: 60 }, (_, i) => template('large' + i, '名称' + i, '正文' + i)), video: [],
} });
assert.equal(store.migrate('beta', 'large').added, 4);
assert.equal(store.load('large').image.length, 63, '迁移不能截掉目标旧模板');
const beforeFailure = s.getItem(PROJECT_PREFIX + 'beta');
s.blocked = PROJECT_PREFIX + 'beta';
assert.throws(() => store.migrate('large', 'beta'), /QuotaExceededError/);
assert.equal(s.getItem(PROJECT_PREFIX + 'beta'), beforeFailure);
s.blocked = '';
put('broken', { x: true }); s.setItem(PROJECT_PREFIX + 'broken', '{broken');
assert.throws(() => store.migrate('large', 'broken'));
assert.equal(s.getItem(PROJECT_PREFIX + 'broken'), '{broken', '坏记录不能被覆盖成空白');
assert.throws(() => store.migrate('beta', 'beta'), /另一个目标剧本/);
assert.throws(() => store.load('../other'), /标识无效/);
assert.equal(create(s).load('large').image.length, 63, '重建存储对象后仍保留');
console.log('PROMPT_TEMPLATE_STORE_PASS appendBothModes preserveSourceAndTarget independentEdits repeatedSkip noTruncation failedWritePreserves legacyOwnerOnly');
