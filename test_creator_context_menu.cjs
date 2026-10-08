'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { buildCreatorContextMenuTemplate } = require('./electron/creator-context-menu.cjs');

function fakeContents() {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => calls.push(['back']),
      goForward: () => calls.push(['forward']),
    },
    copyImageAt: (x, y) => calls.push(['copy-image', x, y]),
    copyVideoFrameAt: (x, y) => calls.push(['copy-video-frame', x, y]),
    undo: () => calls.push(['undo']),
    redo: () => calls.push(['redo']),
    cut: () => calls.push(['cut']),
    copy: () => calls.push(['copy']),
    paste: () => calls.push(['paste']),
    selectAll: () => calls.push(['select-all']),
    reload: () => calls.push(['reload']),
  };
}

const contents = fakeContents();
const clipboardWrites = [];
const clipboard = { writeText: value => clipboardWrites.push(value) };
const imageMenu = buildCreatorContextMenuTemplate({
  contents,
  clipboard,
  params: {
    x: 321,
    y: 654,
    mediaType: 'image',
    hasImageContents: true,
    srcURL: 'https://images.example/asset.png',
    linkURL: '',
    selectionText: '',
    isEditable: false,
    editFlags: {},
  },
});

const imageIds = imageMenu.filter(item => item.id).map(item => item.id);
assert.deepEqual(imageIds, ['copy-image', 'copy-image-address', 'go-back', 'go-forward', 'reload']);
imageMenu.find(item => item.id === 'copy-image').click();
imageMenu.find(item => item.id === 'copy-image-address').click();
imageMenu.find(item => item.id === 'go-back').click();
imageMenu.find(item => item.id === 'reload').click();
assert.deepEqual(contents.calls, [
  ['copy-image', 321, 654],
  ['back'],
  ['reload'],
]);
assert.deepEqual(clipboardWrites, ['https://images.example/asset.png']);
assert.equal(imageMenu.find(item => item.id === 'go-forward').enabled, false);

const editable = buildCreatorContextMenuTemplate({
  contents,
  clipboard,
  params: {
    mediaType: 'none',
    isEditable: true,
    editFlags: { canUndo: false, canRedo: true, canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
  },
});
assert.equal(editable.find(item => item.id === 'undo').enabled, false);
assert.equal(editable.find(item => item.id === 'copy').enabled, true);
editable.find(item => item.id === 'copy').click();
assert.deepEqual(contents.calls.at(-1), ['copy']);

const video = buildCreatorContextMenuTemplate({
  contents,
  clipboard,
  params: { x: 8, y: 9, mediaType: 'video', isEditable: false, editFlags: {} },
});
video.find(item => item.id === 'copy-video-frame').click();
assert.deepEqual(contents.calls.at(-1), ['copy-video-frame', 8, 9]);

assert.deepEqual(buildCreatorContextMenuTemplate({
  contents: { isDestroyed: () => true },
  clipboard,
  params: { mediaType: 'image', hasImageContents: true },
}), []);

console.log('CREATOR_CONTEXT_MENU PASS: native image, video, edit and navigation actions');

// —— 标签右键菜单小窗（无边框窗口版原生菜单）——
// 桌面端 creator:show-tab-menu 已由原生 Menu.popup 换成菜单小窗，用于支持「消失前驻留 500ms」。
// 这里起一个隔离 Electron 实例（VIDEO_OS_TAB_MENU_TEST=1 驱动 main.cjs 内置的确定性自测钩子），
// 真实走 creator 渲染层 invoke → IPC → 菜单小窗渲染 → 点选/取消回执全链路：
// 覆盖白名单过滤、点选回执、禁用项无回执、Esc/blur 驻留 500ms、驻留期内重呼、边缘坐标钳制。
async function assertPortFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(`标签菜单测试端口 ${port} 被占用（${error.code}），可能存在其他视频制作 OS 实例`)));
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

async function runTabMenuIpcSection() {
  const electronExe = require('electron');
  await assertPortFree(3786);
  const runRoot = path.join(__dirname, 'test-artifacts', `tab-menu-ipc-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.join(runRoot, 'project', '创作资产库', '测试剧本'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  let child = null;
  try {
    const output = await new Promise((resolve, reject) => {
      child = spawn(electronExe, [__dirname], {
        cwd: __dirname,
        windowsHide: true,
        env: {
          ...process.env,
          VIDEO_OS_TAB_MENU_TEST: '1',
          CREATOR_BROWSER_TEST: '1',
          VIDEO_OS_SMOKE_TEST: '0',
          VIDEO_OS_LOAD_TIMEOUT_MS: '4000',
          VIDEO_OS_PORT: '3786',
          VIDEO_OS_PROJECT_ROOT: path.join(runRoot, 'project'),
          VIDEO_OS_TEST_PROJECT_ROOT: path.join(runRoot, 'project'),
          VIDEO_OS_COMPAT_MODE: '1',
          VIDEO_OS_USER_DATA: path.join(runRoot, 'user-data'),
          VIDEO_OS_DATA_DIR: path.join(runRoot, 'data'),
          ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let combined = '';
      child.stdout.on('data', chunk => { combined += chunk.toString(); });
      child.stderr.on('data', chunk => { combined += chunk.toString(); });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`标签菜单 IPC 链路测试超时：\n${combined}`));
      }, 90000);
      child.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve(combined);
        else reject(new Error(`Electron 退出码 ${code}：\n${combined}`));
      });
    });
    assert.match(output, /TAB_MENU_IPC_PASS/, `标签菜单自测钩子未产出 PASS：\n${output}`);
    assert.doesNotMatch(output, /TAB_MENU_IPC_FAIL/, `标签菜单自测钩子报错：\n${output}`);
    console.log(output.match(/TAB_MENU_IPC_PASS[^\r\n]*/)?.[0] || 'TAB_MENU_IPC_PASS');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    try {
      fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    } catch (error) {
      console.warn(`标签菜单测试临时目录稍后清理：${error.message}`);
    }
  }
}

runTabMenuIpcSection()
  .then(() => console.log('TAB_MENU_CONTEXT_MENU_TEST PASS: whitelist filter, pick/cancel receipts, 500ms dwell, recall, edge clamp'))
  .catch(error => {
    console.error('标签菜单测试失败：', error.message || error);
    process.exitCode = 1;
  });
