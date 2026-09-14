'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { _electron: electron } = require('playwright');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-workflow-ui-')));
let app;
async function run() {
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '创作资产库', '测试剧本'), { recursive: true });
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
  await new Promise(r => server.close(r));
  const env = { ...process.env, CREATOR_BROWSER_TEST: '1', VIDEO_OS_PORT: String(port),
    VIDEO_OS_PROJECT_ROOT: project, VIDEO_OS_TEST_PROJECT_ROOT: project,
    VIDEO_OS_DATA_DIR: path.join(root, 'data'), VIDEO_OS_USER_DATA: path.join(root, 'user-data'),
    VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(root, 'vault'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' };
  async function launch() {
    app = await electron.launch({ args: [__dirname], env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    return page;
  }
  let page = await launch();
  const run = await page.evaluate(async () => {
    const a = window.creatorAPI;
    await a.openTab('gpt', 'image');
    await a.openTab('gpt', 'image');
    await a.openTab('updream', 'video');
    const state = await a.automation('browser_state');
    const image = state.tabs.filter(t => t.mode === 'image');
    const video = state.tabs.find(t => t.mode === 'video');
    return a.automation('workflow_create', { projectId: state.project.id, title: '隔离测试：第10集第3段', promptTabId: image[0].id, imageTabId: image[1].id, videoTabId: video.id });
  });
  await page.getByRole('button', { name: '制作流程', exact: true }).click();
  await page.getByText('隔离测试：第10集第3段 · 读取提示词', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看与接续', exact: true }).click();
  await page.locator('.automation-dialog textarea').fill('下次从资产补齐继续');
  await page.getByRole('button', { name: '保存备注', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.automation-dialog textarea')?.value === '下次从资产补齐继续');
  const latest = await page.evaluate(({ id, projectId }) => window.creatorAPI.automation('workflow_get', { id, projectId }), run);
  assert.equal(latest.notes, '下次从资产补齐继续');
  await app.close(); app = null;
  page = await launch();
  const restored = await page.evaluate(({ id, projectId }) => window.creatorAPI.automation('workflow_get', { id, projectId }), run);
  assert.equal(restored.notes, latest.notes); assert.equal(restored.revision, latest.revision);
  await page.getByRole('button', { name: '制作流程', exact: true }).click();
  await page.getByText('隔离测试：第10集第3段 · 读取提示词', { exact: true }).waitFor();
  console.log('FULL_APP_WORKFLOW_UI_AND_RESTART_PASS');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { await app?.close(); fs.rmSync(root, { recursive: true, force: true }); });
