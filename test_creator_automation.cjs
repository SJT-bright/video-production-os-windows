'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createAutomationStore } = require('./electron/automation-store.cjs');
const { serveAutomation, TOOLS } = require('./electron/creator-automation.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-automation-'));

async function run() {
  const directory = path.join(root, 'store');
  const store = createAutomationStore(directory);
  let run = store.create({ projectId: 'p', title: '第10集第3段', bindings: {} });
  assert.throws(() => store.update({ id: run.id, projectId: 'p', revision: 0, patch: { stage: 'assets' } }), /完整提示词/);
  run = store.update({ id: run.id, projectId: 'p', revision: 0, patch: { stage: 'assets', prompt: '原始提示词', tailMode: 'reference', newScene: true } });
  assert.throws(() => store.update({ id: run.id, projectId: 'p', revision: 0, patch: { notes: '过期写入' } }), /已改变/);
  assert.throws(() => store.get(run.id, 'other'), /当前项目/);
  assert.throws(() => store.update({ id: run.id, projectId: 'p', revision: 1, patch: { stage: 'references' } }), /成片尾帧/);
  run = store.update({ id: run.id, projectId: 'p', revision: 1, patch: { stage: 'references', assets: [{ key: '图1', purpose: '连续性', role: 'tail', path: 'p/tail.png', status: 'ready' }] } });
  assert.throws(() => store.update({ id: run.id, projectId: 'p', revision: 2, patch: { stage: 'submit' } }), /网站绑定/);
  run = store.update({ id: run.id, projectId: 'p', revision: 2, patch: { stage: 'submit', assets: [{ ...run.assets[0], status: 'bound', binding: '场景槽位：尾帧' }] } });
  assert.throws(() => store.update({ id: run.id, projectId: 'p', revision: 3, patch: { stage: 'generating' } }), /提交回执/);
  let effects = 0;
  const request = { projectId: 'p', name: 'generate' };
  await store.once('submit-one', request, async () => { effects++; return { taskId: 'task1' }; });
  const replay = await store.once('submit-one', request, async () => { effects++; });
  assert.equal(effects, 1); assert.equal(replay.replayed, true);
  await assert.rejects(store.once('submit-one', { ...request, name: 'other' }, async () => {}), /不同请求/);
  await assert.rejects(store.once('uncertain', request, async () => { throw new Error('network disconnect'); }));
  const restored = createAutomationStore(directory);
  assert.equal(restored.get(run.id, 'p').stage, 'submit');
  await assert.rejects(restored.once('uncertain', request, async () => { effects++; }), /不确定/);
  assert.equal(effects, 1);
  assert.throws(() => restored.resolveOperation({ id: 'uncertain', projectId: 'other', evidence: '检查队列', outcome: 'completed' }), /不能补录/);
  restored.resolveOperation({ id: 'uncertain', projectId: 'p', evidence: '队列任务42已存在', outcome: 'completed' });
  console.log('WORKFLOW_RECOVERY_AND_IDEMPOTENCY_PASS');

  const connectionFile = path.join(root, 'connection.json');
  const server = await serveAutomation({ tools: TOOLS, call: async (name, args) => ({ name, args, fixture: true }) }, connectionFile);
  try {
    const info = JSON.parse(fs.readFileSync(connectionFile, 'utf8'));
    assert.equal(fs.statSync(connectionFile).mode & 0o777, 0o600);
    async function post(headers) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: info.port, path: '/call', method: 'POST', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end(JSON.stringify({ name: 'browser_state' }));
      });
    }
    assert.equal(await post({}), 403);
    assert.equal(await post({ authorization: `Bearer ${info.token}`, origin: 'https://untrusted.example' }), 403);
    assert.equal(await post({ authorization: `Bearer ${info.token}` }), 200);
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_state', arguments: {} } },
    ];
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, 'electron/creator-mcp.cjs'), '--connection', connectionFile], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    });
    const replies = output.trim().split('\n').map(JSON.parse);
    assert.equal(replies[0].result.protocolVersion, '2025-06-18');
    assert.equal(replies[1].result.tools.length, TOOLS.length);
    assert.equal(replies[2].result.structuredContent.result.fixture, true);
    console.log('LOCAL_AUTH_AND_MCP_STDIO_PASS');
  } finally { server.close(); }
  assert.equal(fs.existsSync(connectionFile), false);
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
