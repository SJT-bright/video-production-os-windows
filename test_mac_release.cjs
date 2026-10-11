'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { assertMacBundle } = require('./verify-mac-bundle.cjs');

async function run() {
  const appBundle = path.join(__dirname, 'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app');
  assertMacBundle({ appBundle, sourceRoot: __dirname, arch: 'universal', portable: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vos-mac-release-'));
  let child;
  try {
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'creator-browser-session.json'), JSON.stringify({
      schemaVersion: 1, tabs: [], activeMode: 'video', lastModeTabs: {}, initializedModes: ['image', 'video'],
    }));
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const env = { ...process.env, VIDEO_OS_USER_DATA: profile, VIDEO_OS_PORT: String(port) };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'CREATOR_BROWSER_TEST', 'VIDEO_OS_SMOKE_TEST', 'VIDEO_OS_DATA_DIR', 'VIDEO_OS_PROJECT_ROOT', 'VIDEO_OS_TEST_PROJECT_ROOT']) delete env[key];
    child = spawn(path.join(appBundle, 'Contents/MacOS/VideoProductionOS'), [], { cwd: root, env, stdio: 'ignore' });
    const connectionFile = path.join(profile, 'workspace/视频制作OS/data/creator-automation-connection.json');
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`App exited: ${child.exitCode}`);
      try {
        const connection = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
        const response = await fetch(`http://127.0.0.1:${connection.port}/call`, {
          method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'browser_state', arguments: {} }), signal: AbortSignal.timeout(1000),
        });
        const body = await response.json();
        if (response.ok && body.result?.project) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'Standalone app must start with a fresh user workspace');
    assert.equal(fs.existsSync(path.join(appBundle, 'Contents/Resources/app/data')), false);
    console.log('MAC_STANDALONE_LAUNCH_PASS universal=true freshUserWorkspace=true bundledPrivateData=false');
  } finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
