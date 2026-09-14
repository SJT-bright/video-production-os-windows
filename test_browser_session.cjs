'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBrowserSessionStore, MAX_TAB_NAME_LENGTH } = require('./electron/browser-session.cjs');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-browser-session-'));

try {
  const filePath = path.join(testRoot, 'profile', 'browser-session.json');
  const warnings = [];
  const store = createBrowserSessionStore({ filePath, onWarning: message => warnings.push(message) });
  assert.equal(store.load(), null, '首次使用无会话文件时应返回 null');
  assert.deepEqual(warnings, []);
  assert.equal(fs.existsSync(path.dirname(filePath)), false, '只读加载不应创建目录');
  assert.throws(() => createBrowserSessionStore({ filePath: 'relative.json' }), /绝对路径/);

  const snapshot = {
    schemaVersion: 1,
    tabs: [
      { id: 'image-1', serviceId: 'gpt', mode: 'image', url: 'https://chatgpt.com/c/image-one?draft=1#latest', customName: '人物图' },
      { id: 'video-1', serviceId: 'gpt', mode: 'video', url: 'https://chatgpt.com/c/video-one#script', customName: '视频脚本' },
      { id: 'image-2', serviceId: 'gpt', mode: 'image', url: 'https://example.com/scene?take=2#result', customName: '场景图' },
    ],
    activeMode: 'video',
    lastModeTabs: { image: 'image-2', video: 'video-1' },
    initializedModes: { image: true, video: true },
  };
  assert.deepEqual(store.save(snapshot), snapshot);
  const reloadedStore = createBrowserSessionStore({ filePath });
  assert.deepEqual(reloadedStore.load(), snapshot, '重建 store 应恢复顺序、名称、地址与每种模式的当前标签');
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), snapshot);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['browser-session.json']);

  const loaded = store.load();
  loaded.tabs[0].url = 'https://mutated.example/';
  loaded.lastModeTabs.image = null;
  loaded.initializedModes.video = false;
  assert.deepEqual(store.load(), snapshot, 'load 返回值不得与存储共享可变对象');
  const saveResult = store.save(snapshot);
  saveResult.tabs[0].customName = '已改动返回值';
  assert.equal(snapshot.tabs[0].customName, '人物图', 'save 不应与输入共享标签对象');
  assert.deepEqual(store.load(), snapshot);

  const edited = JSON.parse(JSON.stringify(snapshot));
  edited.activeMode = 'image';
  edited.lastModeTabs.image = 'image-1';
  edited.tabs[0].customName = '角色最终版';
  edited.tabs[0].url = 'https://chatgpt.com/c/new-conversation#reply-3';
  assert.deepEqual(store.save(edited), edited);
  assert.deepEqual(reloadedStore.load(), edited, '地址、改名和当前标签变更应写回磁盘');

  const deduplicated = store.save({ ...snapshot, tabs: [...snapshot.tabs, { ...snapshot.tabs[0], customName: '重复标签' }] });
  assert.deepEqual(deduplicated.tabs, snapshot.tabs, '重复 ID 保留第一次出现的标签和原顺序');
  const normalized = store.save({
    ...snapshot,
    tabs: [{ ...snapshot.tabs[0], url: 'example.com/path', customName: '图'.repeat(130) }, snapshot.tabs[1]],
    lastModeTabs: { image: 'video-1', video: 'missing' },
  });
  assert.equal(normalized.tabs[0].url, 'https://example.com/path');
  assert.equal([...normalized.tabs[0].customName].length, MAX_TAB_NAME_LENGTH);
  assert.deepEqual(normalized.lastModeTabs, { image: null, video: null }, '失效或跨模式的当前标签引用必须清除');

  const empty = {
    schemaVersion: 1, tabs: [], activeMode: 'video',
    lastModeTabs: { image: null, video: null }, initializedModes: { image: true, video: true },
  };
  assert.deepEqual(store.save(empty), empty);
  assert.deepEqual(reloadedStore.load(), empty, '主动清空后重启仍须保留空列表和已初始化标志');
  const partiallyInitialized = { ...empty, activeMode: 'image', initializedModes: { image: true, video: false } };
  assert.deepEqual(store.save(partiallyInitialized), partiallyInitialized);
  assert.deepEqual(store.load(), partiallyInitialized, '未打开过的模式应与主动清空的模式区分');

  store.save(snapshot);
  const beforeFailure = fs.readFileSync(filePath, 'utf-8');
  for (const invalid of [null, [], {}, { ...snapshot, schemaVersion: 2 }, { ...snapshot, tabs: {} },
    { ...snapshot, activeMode: 'audio' }, { ...snapshot, tabs: [{ ...snapshot.tabs[0], mode: 'audio' }] },
    { ...snapshot, tabs: [{ ...snapshot.tabs[0], id: '' }] },
    { ...snapshot, tabs: [{ ...snapshot.tabs[0], serviceId: '' }] },
    { ...snapshot, tabs: [{ ...snapshot.tabs[0], url: {} }] }]) {
    assert.throws(() => store.save(invalid), /浏览器会话/);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), beforeFailure, '校验失败不得覆盖上次有效会话');
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/example', 'about:blank', 'ftp://example.com/', 'https://user:password@example.com/', '']) {
    assert.throws(() => store.save({ ...snapshot, tabs: [{ ...snapshot.tabs[0], url }] }));
    assert.equal(fs.readFileSync(filePath, 'utf-8'), beforeFailure);
  }

  for (const operation of ['writeFileSync', 'renameSync']) {
    const original = fs[operation];
    try {
      fs[operation] = () => { throw new Error(`injected ${operation} failure`); };
      assert.throws(() => store.save(edited), /injected/);
    } finally {
      fs[operation] = original;
    }
    assert.equal(fs.readFileSync(filePath, 'utf-8'), beforeFailure, `${operation} 失败不得损坏上次有效会话`);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['browser-session.json'], '失败后应清理本次临时文件');
  }
  let renameObserved = false;
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      renameObserved = true;
      assert.equal(path.dirname(source), path.dirname(filePath), '临时文件必须和目标在同目录');
      assert.equal(destination, filePath);
      assert.equal(fs.readFileSync(destination, 'utf-8'), beforeFailure, '提交前目标文件应仍为完整旧会话');
      assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf-8')), edited, '原子替换前临时文件应为完整新会话');
      return rename(source, destination);
    };
    store.save(edited);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(renameObserved, true, '写入应使用原子替换');
  assert.deepEqual(store.load(), edited);

  const corruptPath = path.join(testRoot, 'corrupt-session.json');
  const corruptStore = createBrowserSessionStore({ filePath: corruptPath, onWarning: message => warnings.push(message) });
  for (const corrupt of ['{broken json', JSON.stringify({ ...snapshot, activeMode: 'audio' }),
    JSON.stringify({ ...snapshot, tabs: [{ ...snapshot.tabs[0], url: 'file:///tmp/example' }] })]) {
    fs.writeFileSync(corruptPath, corrupt, 'utf-8');
    assert.equal(corruptStore.load(), null);
    assert.equal(fs.readFileSync(corruptPath, 'utf-8'), corrupt, '加载损坏会话必须保留原文件');
  }
  assert.equal(warnings.length, 3);
  assert.equal(fs.readdirSync(testRoot).some(name => name.includes('.corrupt-')), false);
  console.log('BROWSER_SESSION_PASS orderedTabs=true modeIsolation=true restartRestore=true emptySession=true atomicWrite=true corruptFilePreserved=true');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
