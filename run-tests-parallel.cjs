#!/usr/bin/env node
'use strict';
/**
 * 并行回归跑测试：把 test_*.cjs 作为独立子进程同时运行。
 * - 自动为依赖外部 fixture 服务器的测试（creator-assets/creator-ui）起停隔离服务器
 * - 人工验收与环境依赖测试单列 SKIPPED，不算失败（test_electron 需要安静前台，
 *   test_quick_asset_drag 需要真实鼠标手势，test_desktop_package 需要 win32 构建产物）
 * - 长测试优先调度；每个子进程有超时保护
 * - 失败套件的完整输出在最后集中打印，任一套件失败则整体退出码 1
 */
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = __dirname;
const concurrency = 4;  // Electron 实例并行启动资源占用高，4 并发稳定
const TEST_TIMEOUT_MS = 300000;

// 需要外部静态服务器（API 由 Playwright route mock，服务器只托管页面）
const FIXTURE_TESTS = {
  'test_creator_assets.cjs': 3791,
  'test_creator_ui.cjs': 3792,
};
// 无人值守跑批无法满足前置条件，单独人工验收
const SKIP_TESTS = {
  'test_electron.cjs': '需要安静前台窗口焦点（用户使用机器时 sendInputEvent 不可靠），请单独在空闲时验收',
  'test_quick_asset_drag.cjs': '需要真实系统鼠标拖拽手势（半自动人工验收）',
  'test_desktop_package.cjs': '依赖 win32 桌面构建产物，先执行 npm run build:desktop 后单独验证',
};

const tests = fs.readdirSync(root)
  .filter(name => /^test_.+\.cjs$/.test(name))
  .sort((a, b) => weight(b) - weight(a));

function weight(name) {
  if (name === 'test_browser.cjs') return 100;
  if (name === 'test_drag_tray.cjs' || name === 'test_focus_link.cjs') return 95;
  if (name === 'test_creator_ui.cjs') return 80;
  if (name === 'test_creator_assets.cjs') return 70;
  if (name === 'test_mac_contract.cjs' || name === 'test_mode_tabs_packaged.cjs') return 60;
  return fs.statSync(path.join(root, name)).size / 1024;
}

const results = [];
const fixtureServers = [];
let cursor = 0;
let running = 0;
let finishing = false;

function startFixtureServer(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `wp-fixture-${port}-`));
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['server.js', '--port', String(port)], {
      cwd: root,
      env: { ...process.env, VIDEO_OS_DATA_DIR: dataDir, VIDEO_OS_PROJECT_ROOT: dataDir },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    fixtureServers.push({ child, dataDir });
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta', timeout: 800 }, res => {
        res.resume();
        if (res.statusCode < 500) resolve(child);
        else retry();
      });
      req.once('error', retry);
      req.once('timeout', () => { req.destroy(); retry(); });
    };
    let tries = 0;
    const retry = () => { if (++tries > 40) resolve(child); else setTimeout(probe, 250); };
    probe();
  });
}

function runTest(name, args = []) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(root, name), ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { out += chunk; });
    const timer = setTimeout(() => {
      out += `\n[跑批] 超时 ${TEST_TIMEOUT_MS / 1000}s，强制终止\n`;
      child.kill('SIGKILL');
    }, TEST_TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ name, code, ms: Date.now() - started, out });
    });
  });
}

async function next() {
  while (running < concurrency && cursor < tests.length) {
    const name = tests[cursor++];
    if (SKIP_TESTS[name]) {
      results.push({ name, code: null, ms: 0, out: SKIP_TESTS[name] });
      continue;
    }
    running++;
    const fixturePort = FIXTURE_TESTS[name];
    const promise = fixturePort
      ? startFixtureServer(fixturePort).then(() => runTest(name, [`http://127.0.0.1:${fixturePort}`]))
      : runTest(name);
    promise.then(result => {
      results.push(result);
      running--;
      next();
      if (running === 0 && cursor >= tests.length && !finishing) { finishing = true; finish(); }
    });
  }
}

function finish() {
  for (const { child, dataDir } of fixtureServers) {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  let failed = 0;
  console.log('==== 并行回归结果 ====');
  for (const r of results) {
    if (r.code === null) { console.log(`SKIP              ${r.name}（${r.out}）`); continue; }
    const ok = r.code === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${String((r.ms / 1000).toFixed(1) + 's').padStart(6)}  ${r.name}`);
  }
  console.log(`==== 共 ${results.length} 套，失败 ${failed} 套，并发 ${concurrency} ====`);

  for (const r of results.filter(r => r.code !== null && r.code !== 0)) {
    console.log(`\n---- ${r.name} 的输出（尾部 80 行）----`);
    console.log(r.out.split('\n').slice(-80).join('\n'));
  }
  process.exitCode = failed ? 1 : 0;
}

if (tests.length === 0) {
  console.error('没有发现 test_*.cjs');
  process.exit(1);
}
console.log(`并行运行 ${tests.length} 套测试，并发上限 ${concurrency}（npm run check 请单独执行）`);
next();
