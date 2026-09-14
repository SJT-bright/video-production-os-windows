'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const runRoot = path.join(__dirname, 'test-artifacts', `electron-smoke-${process.pid}-${Date.now()}`);
const electronExe = require('electron');

async function run() {
  assert.ok(fs.existsSync(electronExe), 'Electron 运行文件不存在，请先安装桌面版依赖');
  fs.mkdirSync(path.join(runRoot, 'project'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'project', '创作资产库', '测试剧本'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'obsidian'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'user-data'), { recursive: true });
  fs.mkdirSync(path.join(runRoot, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(runRoot, 'obsidian', '测试角色.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );
  fs.writeFileSync(
    path.join(runRoot, 'project', '创作资产库', '测试剧本', '测试角色.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );

  let child = null;
  let failed = false;
  try {
    // 隔离前提：3785 必须空闲，避免把烟测流量/断言打到其他运行实例上。
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', error => reject(new Error(`烟测端口 3785 被占用（${error.code}），可能存在其他视频制作 OS 实例，已拒绝启动隔离烟测`)));
      probe.once('listening', () => probe.close(() => resolve()));
      probe.listen(3785, '127.0.0.1');
    });
    const output = await new Promise((resolve, reject) => {
      child = spawn(electronExe, [__dirname], {
        cwd: __dirname,
        windowsHide: true,
        env: {
          ...process.env,
          CREATOR_BROWSER_TEST: '1',
          VIDEO_OS_SMOKE_TEST: '1',
          VIDEO_OS_LOAD_TIMEOUT_MS: '2000',
          VIDEO_OS_PORT: '3785',
          VIDEO_OS_PROJECT_ROOT: path.join(runRoot, 'project'),
          VIDEO_OS_TEST_PROJECT_ROOT: path.join(runRoot, 'project'),
          VIDEO_OS_COMPAT_MODE: '1', VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(runRoot, 'obsidian'),
          OBSIDIAN_VAULT_PATH: path.join(runRoot, 'obsidian'),
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
        reject(new Error(`Electron 烟雾测试超时：\n${combined}`));
      }, 30000);
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

    assert.match(output, /ELECTRON_SMOKE_PASS/, output);
    assert.match(output, /MODE_ISOLATION_PASS/, output);
    assert.match(output, /ASSET_OVERLAY_FOCUS_PASS/, output);
    // 实例独立性：服务器横幅必须确认使用本次 runRoot 下的隔离数据目录。
    assert.ok(output.includes(`OS 数据目录：${path.join(runRoot, 'data')}`), '烟测实例未确认使用隔离数据目录');
    assert.match(output, /OVERLAY_SHIELD_PASS/, output);
    assert.match(output, /PROJECT_SWITCH_IPC_PASS/, output);
    assert.match(output, /FOCUS_LINK_PASS/, output);
    assert.match(output, /SAME_WINDOW_NAVIGATION_PASS/, output);
    console.log(output.match(/SAME_WINDOW_NAVIGATION_PASS[^\r\n]*/)?.[0]);
    console.log(output.match(/FOCUS_LINK_PASS[^\r\n]*/)?.[0] || 'FOCUS_LINK_PASS 未产出');
    console.log(output.match(/ASSET_OVERLAY_FOCUS_PASS[^\r\n]*/)?.[0]);
    console.log(output.match(/OVERLAY_SHIELD_PASS[^\r\n]*/)?.[0]);
    console.log(output.match(/PROJECT_SWITCH_IPC_PASS[^\r\n]*/)?.[0]);
    console.log(output.match(/POINTER_DIAG[^\r\n]*/)?.[0] || 'POINTER_DIAG 未产出');
    console.log(output.match(/POINTER_VERDICT[^\r\n]*/)?.[0] || 'POINTER_VERDICT 未产出');
    console.log(output.match(/SMOKE_WINDOW_CAPTURE[^\r\n]*/)?.[0] || 'SMOKE_WINDOW_CAPTURE_UNAVAILABLE（像素探针未产出）');
    console.log(output.match(/MODE_ISOLATION_PASS[^\r\n]*/)?.[0]);
    console.log(output.match(/ELECTRON_SMOKE_PASS[^\r\n]*/)?.[0] || 'ELECTRON_SMOKE_PASS');
  } catch (error) {
    failed = true;
    console.error('烟雾测试失败：', error.message || error);
    // 失败必须以非零退出码结束，供 CI/监工识别。
    process.exitCode = 1;
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    }
    if (!failed) {
      const artifactRoot = path.resolve(__dirname, 'test-artifacts') + path.sep;
      assert.ok(path.resolve(runRoot).startsWith(artifactRoot), '拒绝清理测试产物目录以外的路径');
      try {
        fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch (error) {
        console.warn(`测试临时目录稍后清理：${error.message}`);
      }
    } else {
      console.log(`DEBUG-RUNROOT-KEPT(测试失败，保留现场): ${runRoot}`);
    }
  }
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
