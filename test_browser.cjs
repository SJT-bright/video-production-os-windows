/* Local smoke and security probe for the video-production OS.
 * This test owns its server and data directory. It must never use port 3750
 * or connect to an already-running user instance because it creates test shots.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { launchChromium } = require('./test-playwright.cjs');
const { SCHEMA_VERSION: SCRIPT_BREAKDOWN_SCHEMA } = require('./script-breakdown-store.cjs');
const HEHUI_PROJECT_URL = 'https://hehui.dawncoreai.com/drama/project-manage/project-details/project-role?id=1704&project_name=%E7%9F%AD%E5%89%A7+%E3%80%8A%E9%99%86%E6%80%BB%EF%BC%8C%E5%88%AB%E8%BF%BD%E4%BA%86%E3%80%8B';

let BASE_URL = '';
let activeBrowser = null;
let serverChild = null;
let serverOutput = '';
let runRoot = '';
let testDataDir = '';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireTestRoot(target) {
  const artifactRoot = path.resolve(__dirname, 'test-artifacts') + path.sep;
  if (!path.resolve(target).startsWith(artifactRoot)) throw new Error('拒绝使用或清理测试产物目录以外的路径');
}

function scriptBreakdownFixture() {
  return {
    schemaVersion: SCRIPT_BREAKDOWN_SCHEMA,
    documentId: 'browser-test-episode-01',
    project: '浏览器测试项目',
    title: '第一集｜走廊重逢',
    episode: 'E01',
    createdAt: '2026-08-30T08:00:00.000Z',
    source: { mode: 'text', file: '第一集.md', note: '浏览器隔离测试固定样本' },
    summary: { logline: '两位学生在走廊意外重逢。' },
    groups: [{
      id: 'G01', title: '场次1-1｜走廊重逢', durationSec: 6,
      storyFunction: '建立意外重逢。', scene: '教学楼走廊／日内', characters: ['苏晚', '陈叙'],
      description: '苏晚停步，陈叙抬眼。', voiceover: '无', endBeat: '两人隔着数步对视。',
    }],
    shots: [{
      id: 'E01-S001', shotNo: 'S001', groupId: 'G01', title: '走廊停步',
      storyTask: '让两人第一次看见彼此。', durationSec: 6, scene: '教学楼走廊／日内',
      characters: ['苏晚', '陈叙'], startState: '苏晚从画面左侧走入，陈叙位于右后景。',
      action: '苏晚听见脚步后停下并抬眼。', performance: '她的呼吸短暂停顿，视线落在陈叙脸上。',
      camera: '真实三脚架平视中景，40mm 适度景深。', endState: '苏晚停在左侧，陈叙仍在右后景。',
      generation: {
        tool: 'Seedance 2.0', status: 'ready', promptLanguage: 'zh-CN', missingInputs: [],
        referenceAssets: ['@图1：用于锁定苏晚面部。'], prompt: '浏览器测试用的完整逐镜视频提示词。',
      },
      acceptance: ['人物数量为两人', '动作结束后站位清楚'],
    }],
  };
}

async function startIsolatedServer() {
  if (process.argv.length > 2) throw new Error('test_browser.cjs 不接受外部 URL；该测试会写入隔离 SQLite，不能连接任何现有网站。');
  const artifactRoot = path.join(__dirname, 'test-artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  runRoot = fs.mkdtempSync(path.join(artifactRoot, 'browser-'));
  requireTestRoot(runRoot);
  const projectRoot = path.join(runRoot, 'project');
  const assetRoot = path.join(projectRoot, '素材库');
  const obsidianRoot = path.join(runRoot, 'obsidian');
  const vaultProjectRoot = path.join(obsidianRoot, 'ai创作短剧', '韩剧制作');
  testDataDir = path.join(runRoot, 'data');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(vaultProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'VIDEO-001_浏览器测试蒸馏.md'), '# 浏览器测试蒸馏\n用于全局搜索回归。\n', 'utf-8');
  fs.writeFileSync(path.join(vaultProjectRoot, '场景资产.md'), '# 场景资产\n教学楼走廊。\n', 'utf-8');
  fs.writeFileSync(path.join(vaultProjectRoot, '色卡.md'), '# 色卡\n白天母色卡。\n', 'utf-8');
  fs.writeFileSync(path.join(vaultProjectRoot, '资产库.md'), '# 资产库\n韩秀雅\n\n![[角色参考.png]]\n', 'utf-8');
  fs.writeFileSync(
    path.join(vaultProjectRoot, '角色参考.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );
  const breakdownDir = path.join(testDataDir, 'script-breakdowns');
  fs.mkdirSync(breakdownDir, { recursive: true });
  fs.writeFileSync(path.join(breakdownDir, 'E01-走廊重逢.json'), JSON.stringify(scriptBreakdownFixture(), null, 2), 'utf-8');
  if (path.resolve(testDataDir) === path.resolve(__dirname, 'data')) throw new Error('浏览器测试拒绝使用正式 data 目录');

  const requestedPort = 3900 + (process.pid % 500);
  serverChild = spawn(process.execPath, ['server.js', '--port', String(requestedPort)], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      VIDEO_OS_PROJECT_ROOT: projectRoot,
      VIDEO_OS_DATA_DIR: testDataDir,
      OBSIDIAN_VAULT_PATH: obsidianRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverChild.stdout.on('data', chunk => { serverOutput += chunk.toString(); });
  serverChild.stderr.on('data', chunk => { serverOutput += chunk.toString(); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const match = serverOutput.match(/浏览器打开：(http:\/\/localhost:(\d+))/);
    if (match) {
      const candidate = match[1].replace('localhost', '127.0.0.1');
      try {
        const response = await fetch(`${candidate}/api/production`);
        if (response.ok) {
          const expectedDataLine = `OS 数据目录：${path.resolve(testDataDir)}`;
          if (!serverOutput.includes(expectedDataLine)) throw new Error('隔离服务器没有确认临时 data 目录');
          return candidate;
        }
      } catch (error) {
        if (error.message.includes('临时 data')) throw error;
      }
    }
    if (serverChild.exitCode !== null) throw new Error(`隔离服务器提前退出：${serverOutput}`);
    await wait(80);
  }
  throw new Error(`隔离服务器启动超时：${serverOutput}`);
}

async function stopIsolatedServer() {
  const child = serverChild;
  serverChild = null;
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve();
    }, 3500);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.kill(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function finish(code) {
  if (activeBrowser) {
    try { await activeBrowser.close(); } catch {}
    activeBrowser = null;
  }
  await stopIsolatedServer();
  if (!runRoot) return process.exit(code);
  requireTestRoot(runRoot);
  if (code === 0) {
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } else {
    console.error(`BROWSER_TEST_DIAGNOSTICS ${runRoot}`);
  }
  process.exit(code);
}

function parentFolder(filePath) {
  const parts = filePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '项目根目录';
}

async function main() {
  BASE_URL = await startIsolatedServer();
  const consoleErrors = [];
  const pageErrors = [];
  const browserHttpErrors = [];
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const browser = activeBrowser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('response', browserResponse => {
    if (browserResponse.status() >= 400) browserHttpErrors.push(`${browserResponse.status()} ${browserResponse.url()}`);
  });

  const response = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  const initialScanResponse = await page.request.get(BASE_URL + '/api/scan');
  const scanPayload = initialScanResponse.ok() ? await initialScanResponse.json() : null;
  const indexedVideos = scanPayload ? scanPayload.files.filter(file => file.type === 'video') : [];
  const activeIndexedMedia = scanPayload ? scanPayload.files.filter(file => !file.hidden && !(file.meta && file.meta.rejected)) : [];
  const visibleIndexedVideos = indexedVideos.filter(file => !file.hidden);
  const activeIndexedVideos = visibleIndexedVideos.filter(file => !(file.meta && file.meta.rejected));
  const indexedAudio = scanPayload ? scanPayload.files.filter(file => file.type === 'audio' && !file.hidden && !(file.meta && file.meta.rejected)) : [];
  const indexedFinals = activeIndexedVideos.filter(file => file.meta && file.meta.isFinal === true);
  await page.locator('.creator-launcher').waitFor({ state: 'visible' });
  console.log(`PAGE status=${response ? response.status() : 'none'} title=${JSON.stringify(await page.title())}`);
  console.log(`SHELL nav=${await page.locator('.side-nav-item').count()} activeCount=${await page.locator('.side-nav-item.active').count()}`);
  console.log(`CREATOR lanes=${await page.locator('.creator-lane').count()} windows=${await page.locator('.window').count()}`);
  check(response && response.status() === 200, '首页不是 200');
  check(initialScanResponse.status() === 200, '/api/scan 初始请求不是 200');
  check(scanPayload && scanPayload.assetRoot === '素材库' && scanPayload.assetAvailable,
    '/api/scan 没有声明专用素材库目录');
  check(scanPayload && scanPayload.files.every(file => file.path.startsWith('素材库/') || file.path.startsWith('@media/source-')),
    '扫描结果包含无法映射到安全来源 token 的文件');
  check(scanPayload && scanPayload.files.every(file => ['video', 'image', 'audio'].includes(file.type)),
    '扫描结果混入了文档或不支持的媒体类型');
  check(scanPayload && scanPayload.sources?.some(source => source.id === 'project-assets' && source.builtIn)
    && scanPayload.sources?.some(source => source.id === 'creative-assets' && source.builtIn),
    '/api/scan 没有返回内置项目与创作工作台媒体来源');
  await page.emulateMedia({ colorScheme: 'dark' });
  check(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme) === 'light',
    '主工作台仍会跟随系统深色模式变黑');
  check(await page.locator('.side-nav-item').count() === 12, '精简侧栏应保留 12 个入口（含更多功能开关）');
  check(await page.locator('.side-nav-item[data-app="creator-image"] .side-nav-text').textContent() === '图片创作', '侧栏缺少图片创作入口');
  check(await page.locator('.side-nav-item[data-app="creator-video"] .side-nav-text').textContent() === '视频创作', '侧栏缺少视频创作入口');
  check(await page.locator('.side-nav-group.side-nav-more.collapsed').count() === 1, '更多功能分组默认应折叠');
  await page.locator('.side-nav-more-toggle').click();
  check(await page.locator('.side-nav-group.side-nav-more.collapsed').count() === 0, '点击更多功能应展开低频入口');
  check((await page.locator('.creator-launcher-head').textContent()).includes('让每一次生成'), '创作主入口缺少明确的创作意图标题');
  check(await page.locator('.creator-lane-identifier img').count() === 2, '创作主入口缺少图片与视频模块标识');
  check((await page.locator('.creator-lane.image .creator-lane-identifier img').getAttribute('src')) === 'assets/ui/creator/image-3d-v1.png',
    '图片设计没有使用图片系统标识');
  check((await page.locator('.creator-lane.video .creator-lane-identifier img').getAttribute('src')) === 'assets/ui/creator/video-3d-v1.png',
    '视频设计没有使用视频系统标识');
  check(await page.locator('.creator-launcher img[src^="assets/aigc/"]').count() === 0,
    '创作主入口仍把剧情图片误当作软件标识');
  await page.locator('#createBtn').click();
  await page.locator('#scriptChooser[open]').waitFor({ state: 'visible' });
  check(await page.locator('#inspirationProject').isVisible(), '进入创作没有先显示灵感生成入口');
  check(await page.locator('#scriptProjectList').isVisible(), '进入创作没有显示已有剧本列表');
  await page.locator('#showNewProject').click();
  await page.locator('#newProjectName').fill('浏览器隔离剧本');
  await page.locator('#createProjectSubmit').click();
  await page.waitForFunction(() => !document.querySelector('#scriptChooser')?.open);
  let creativeProjects = await page.request.get(BASE_URL + '/api/creative-projects').then(result => result.json());
  const browserProject = creativeProjects.projects.find(project => project.name === '浏览器隔离剧本');
  check(!!browserProject && creativeProjects.activeProjectId === browserProject.id,
    '新建剧本没有建立稳定归属并设为当前');
  await page.locator('#createBtn').click();
  await page.locator('#scriptChooser[open]').waitFor({ state: 'visible' });
  await page.locator('#inspirationProject').click();
  await page.waitForFunction(() => !document.querySelector('#scriptChooser')?.open);
  creativeProjects = await page.request.get(BASE_URL + '/api/creative-projects').then(result => result.json());
  check(creativeProjects.activeProjectId === 'inspiration', '灵感生成没有使用独立持久项目');
  const inspirationAssets = await page.request.get(BASE_URL + '/api/creative-assets?project=inspiration').then(result => result.json());
  check(inspirationAssets.project?.id === 'inspiration' && !JSON.stringify(inspirationAssets.tree).includes('浏览器隔离剧本'),
    '灵感资产树混入了正式剧本');
  await page.locator('#createBtn').click();
  await page.locator('#scriptChooser[open]').waitFor({ state: 'visible' });
  await page.locator('.script-project-option', { hasText: '浏览器隔离剧本' }).click();
  await page.waitForFunction(() => !document.querySelector('#scriptChooser')?.open);
  creativeProjects = await page.request.get(BASE_URL + '/api/creative-projects').then(result => result.json());
  check(creativeProjects.activeProjectId === browserProject?.id, '继续已有剧本没有恢复对应归属');
  check(await page.locator('#deskIcons, #dock').count() === 0, '旧桌面图标或底部程序坞仍存在于 DOM');
  check(await page.locator('.win-controls:visible').count() === 0, '旧交通灯窗口控件仍然可见');
  await page.locator('.side-nav-item[data-app="overview"]').click();
  await page.locator('.overview-hero').waitFor({ state: 'visible' });
  console.log(`OVERVIEW stats=${await page.locator('.overview-stat').count()}`);
  check((await page.locator('.overview-hero').textContent()).includes('让素材各归其位'), '首页应聚焦网页创作与资产归属');
  check(!(await page.locator('body').textContent()).includes('Remotion'), '当前没有 Remotion 内容却展示了 Remotion 文案');
  const statValues = await page.locator('.overview-stat strong').allTextContents();
  check(Number(statValues[0]) === activeIndexedMedia.filter(file => file.type === 'image').length, '首页图片统计与扫描不一致');
  check(Number(statValues[1]) === activeIndexedVideos.length, '首页视频统计与扫描不一致');
  check(Number(statValues[2]) === indexedFinals.length, '首页成片统计不一致');
  check(Number(statValues[3]) === indexedAudio.length, '首页音频统计不一致');
  check(Number(statValues[4]) === scanPayload.docs.length, '首页文档统计不一致');
  check(await page.locator('.recent-card').count() === Math.min(8, activeIndexedMedia.length),
    '最近入库不是由真实媒体扫描结果派生');
  check((await page.locator('#indexHealth').textContent()).includes('已连接'), '侧栏没有显示本地索引连接状态');
  check(await page.locator('[data-app="scripts"], [data-app="projects"]').count() === 0, '已移除的模块不应出现在导航');
  check(await page.locator('.side-nav-item[data-app="creative-assets"] .side-nav-text').textContent() === '本剧资产', '侧栏资产中心缺少本剧资产入口');
  check(await page.locator('.side-nav-item[data-app="finals"] .side-nav-text').textContent() === '成片库', '侧栏缺少成片库');
  check(await page.locator('.side-nav-item[data-app="obsidian"]').count() === 0, 'Obsidian 已从侧栏导航移除，不应再出现入口');
  const navGroups = await page.locator('.side-nav-group').allTextContents();
  check(navGroups.some(text => ['本剧资产', '图片与视频', '音频素材', '成片库', '外部来源'].every(label => text.includes(label))),
    '资产中心分组缺少完整入口');
  check(navGroups.some(text => ['总览', '项目知识', 'Agent 与规则', '使用说明'].every(label => text.includes(label))),
    '低频功能没有统一收进「更多功能」分组');

  await page.locator('.side-nav-item[data-app="creative-assets"]').click();
  const creativeAssetsFrame = page.frameLocator('.creative-assets-frame');
  await creativeAssetsFrame.locator('.asset-shell').waitFor({ state: 'visible' });
  check((await creativeAssetsFrame.locator('.asset-breadcrumb').textContent()).includes('资产中心 / 创作资产'),
    '创作资产页面没有显示资产中心层级');
  check(await creativeAssetsFrame.locator('html').evaluate(el => getComputedStyle(el).colorScheme) === 'light',
    '创作资产页面仍会跟随系统深色模式变黑');

  const retiredBreakdown = await page.request.get(BASE_URL + '/api/script-breakdowns');
  check(retiredBreakdown.status() === 410, '旧拆解接口应明确返回已下线，不再扫描本地文件');
  await page.locator('.side-nav-item[data-app="finals"]').click();
  await page.locator('.finals-page').waitFor({ state: 'visible' });
  check(await page.locator('.finals-page .recent-card').count() === indexedFinals.length,
    '成片库没有严格按 isFinal 标记派生');
  check(!/remotion/i.test(await page.locator('.finals-page').textContent()), '成片库展示了不存在的 Remotion 内容');

  await page.locator('.side-nav-item[data-app="assets"]').click();
  await page.locator('.assets-app').waitFor({ state: 'visible' });
  const assetStateInput = page.locator('.assets-toolbar input.field').first();
  await assetStateInput.fill('route-state-probe');
  await page.locator('.side-nav-item[data-app="overview"]').click();
  await page.locator('.side-nav-item[data-app="assets"]').click();
  check(await assetStateInput.inputValue() === 'route-state-probe', '侧栏切换重建了素材库并丢失搜索状态');
  check(await page.locator('.side-nav-item[aria-current="page"]').count() === 1, '侧栏存在多个 aria-current 页面');
  await assetStateInput.fill('');
  check(scanPayload && await page.locator('.asset-card').count() === activeIndexedVideos.length,
    '视频素材库的默认卡片数与非隐藏视频数不一致');
  check(await page.locator('.assets-toolbar button', { hasText: '导入视频' }).count() === 1,
    '视频素材库工具栏缺少直接导入入口');
  check(await page.locator('.assets-toolbar button', { hasText: '打开文件夹' }).count() === 1,
    '媒体索引工具栏缺少项目素材文件夹入口');
  check(await page.locator('.assets-toolbar .chip', { hasText: '隐藏目录' }).count() === 1
    && await page.locator('.side-nav-item[data-app="asset-sources"]').count() === 1,
  '媒体索引缺少隐藏目录开关与外部来源入口');
  check(await page.locator('.collection-card').count() === 0, '来源卡已被移除，素材页不应再渲染 collection-card');
  check((response.headers()['content-security-policy'] || '').includes("script-src 'self'"), '首页缺少预期 CSP');
  check(response.headers()['x-content-type-options'] === 'nosniff', '首页缺少 nosniff');

  await page.locator('.side-nav-item[data-app="creator-image"]').click();
  await page.locator('#scriptChooser[open]').waitFor({ state: 'visible' });
  await page.locator('#scriptChooserCancel').click();
  await page.waitForFunction(() => !document.querySelector('#scriptChooser')?.open);
  await page.locator('.creator-launcher').waitFor({ state: 'visible' });
  check(await page.locator('.creator-lane.image').count() === 1, '创作浏览器缺少独立图片模式');
  check(await page.locator('.creator-lane.video').count() === 1, '创作浏览器缺少独立视频模式');
  check(await page.locator('.creator-launch').count() === 2, '创作浏览器缺少两个模式入口');
  check(await page.locator('.creator-lane.image .creator-platform-link').count() === 3, '图片模式平台应包含 GPT、Midjourney 与核绘');
  check(await page.locator('.creator-lane.video .creator-platform-link').count() === 4, '视频模式平台应包含 GPT、Updream、小云雀与核绘');
  check(await page.locator('.creator-lane.image .creator-platform-link', { hasText: '核绘' }).getAttribute('href') === HEHUI_PROJECT_URL,
    '核绘入口没有保留用户指定的项目地址');
  check((await page.locator('.creator-lane.image .creator-archive').textContent()).includes('Obsidian'), '图片模式没有说明 Obsidian 归档');
  check((await page.locator('.creator-lane.video .creator-archive').textContent()).includes('素材库'), '视频模式没有说明素材库归档');
  await page.locator('.creator-lane.image .creator-launch').click();
  await page.locator('#scriptChooser[open]').waitFor({ state: 'visible' });
  await page.locator('.script-project-option', { hasText: '浏览器隔离剧本' }).click();
  await page.waitForFunction(() => !document.querySelector('#scriptChooser')?.open);
  check((await page.locator('#toast').textContent()).includes('桌面版'), '浏览器兼容版没有解释内嵌浏览器的桌面版边界');

  await page.locator('#tbHelpBtn').click();
  console.log(`HELP windows=${await page.locator('.window').count()} title=${JSON.stringify(await page.locator('.window .win-text').last().textContent())}`);
  check(await page.locator('.window .win-text').last().textContent() === '使用说明', '帮助窗口未打开');
  await page.keyboard.press('Escape');

  const knowledgeResponse = await page.request.get(BASE_URL + '/api/knowledge');
  const knowledgePayload = knowledgeResponse.ok() ? await knowledgeResponse.json() : null;
  check(knowledgeResponse.status() === 200 && Array.isArray(knowledgePayload?.sections), 'Agent 经验库数据不可用');
  await page.locator('.side-nav-item[data-app="agent"]').click();
  await page.locator('.agent-app').waitFor({ state: 'visible' });

  for (const section of knowledgePayload?.sections || []) {
    const sectionButton = page.locator('.agent-nav-item', { hasText: section.name }).first();
    await sectionButton.click();
    const cards = page.locator('.agent-main .k-card-collapsible');
    check(await cards.count() === section.items.length, `Agent 分类「${section.name}」折叠卡片数量不正确`);
    check(await cards.locator('.k-card-toggle[aria-expanded="false"]').count() === section.items.length,
      `Agent 分类「${section.name}」没有默认全部收起`);
    check(await cards.locator('.k-card-panel:visible').count() === 0,
      `Agent 分类「${section.name}」默认显示了卡片正文`);
    check(await cards.locator('.md-body').count() === 0,
      `Agent 分类「${section.name}」在展开前提前渲染了正文`);

    if (!section.items.length) continue;
    const firstCard = cards.first();
    const firstToggle = firstCard.locator('.k-card-toggle');
    const compactMetrics = await firstToggle.evaluate(button => {
      const title = button.querySelector('.k-card-title');
      const style = getComputedStyle(title);
      return {
        buttonHeight: button.getBoundingClientRect().height,
        titleHeight: title.getBoundingClientRect().height,
        lineHeight: parseFloat(style.lineHeight),
        titleText: title.textContent,
      };
    });
    check(compactMetrics.buttonHeight >= 44 && compactMetrics.buttonHeight <= 64,
      `Agent 分类「${section.name}」闭合标题行不够紧凑或点击区域不足`);
    check(compactMetrics.titleHeight <= compactMetrics.lineHeight + 1,
      `Agent 分类「${section.name}」闭合标题不是单行`);
    check(compactMetrics.titleText === section.items[0].title,
      `Agent 分类「${section.name}」闭合标题内容不正确`);

    await firstToggle.click();
    await firstCard.locator('.k-card-panel').waitFor({ state: 'visible' });
    check(await firstToggle.getAttribute('aria-expanded') === 'true',
      `Agent 分类「${section.name}」点击后 aria-expanded 未更新`);
    check(await firstCard.evaluate(card => card.classList.contains('open')),
      `Agent 分类「${section.name}」点击后没有展开状态`);
    check((await firstCard.locator('.md-body').textContent()).trim().length > 0,
      `Agent 分类「${section.name}」展开后没有完整正文`);
    check(await firstCard.locator('.k-card-actions button').count() === 2,
      `Agent 分类「${section.name}」展开后缺少编辑或删除操作`);
    check(await firstCard.locator('.k-card-foot button', { hasText: /复制/ }).count() === 1,
      `Agent 分类「${section.name}」展开后缺少复制操作`);
    check(await firstCard.locator('.k-card-foot button', { hasText: '提示词区' }).count() === 1,
      `Agent 分类「${section.name}」展开后缺少发送到创作浏览器入口`);

    await firstToggle.focus();
    await page.keyboard.press('Space');
    check(await firstToggle.getAttribute('aria-expanded') === 'false' &&
      !await firstCard.locator('.k-card-panel').isVisible(),
    `Agent 分类「${section.name}」不能用键盘收起`);
  }

  const searchCard = knowledgePayload?.sections?.find(section => section.items.length)?.items[0];
  if (searchCard) {
    await page.locator('#tbSearch').fill(searchCard.title);
    const result = page.locator('#spResults .sp-item', { hasText: searchCard.title }).first();
    await result.waitFor({ state: 'visible', timeout: 5000 });
    await result.click();
    const openedCard = page.locator(`.agent-main .k-card[data-kid="${searchCard.id}"]`);
    await openedCard.locator('.k-card-panel').waitFor({ state: 'visible' });
    check(await openedCard.locator('.k-card-toggle').getAttribute('aria-expanded') === 'true',
      '从全局搜索打开 Agent 卡片时没有自动展开匹配内容');
  }

  const globalSearchTerm = scanPayload && (
    scanPayload.docs?.[0]?.id ||
    scanPayload.files?.find(file => !file.hidden)?.name
  );
  check(Boolean(globalSearchTerm), '没有可用于全局搜索回归测试的实时文件名');
  await page.locator('#tbSearch').fill(globalSearchTerm || 'VIDEO');
  await page.locator('#spResults .sp-item').first().waitFor({ state: 'visible', timeout: 5000 });
  console.log(`SEARCH visible=${await page.locator('#searchPanel').isVisible()} results=${await page.locator('#spResults .sp-item').count()}`);
  check(await page.locator('#searchPanel').isVisible(), '全局搜索面板未打开');
  check(await page.locator('#spResults .sp-item').count() > 0, `全局搜索没有找到实时存在的项目项：${globalSearchTerm}`);
  await page.keyboard.press('Escape');

  for (const apiPath of ['/api/scan', '/api/knowledge', '/api/meta', '/api/annotations']) {
    const apiResponse = await page.request.get(BASE_URL + apiPath);
    console.log(`GET ${apiPath} status=${apiResponse.status()} content_type=${apiResponse.headers()['content-type'] || ''}`);
    check(apiResponse.status() === 200, `${apiPath} GET 不是 200`);
    if (apiResponse.ok() && apiPath === '/api/scan') {
      const payload = await apiResponse.json();
      console.log('SCAN ' + JSON.stringify({
        rootName: payload.rootName,
        counts: payload.counts,
        files: (payload.files || []).length,
        docs: (payload.docs || []).length,
      }));
    }
  }

  const obsidianTreeResponse = await page.request.get(BASE_URL + '/api/obsidian/tree');
  const obsidianTree = obsidianTreeResponse.ok() ? await obsidianTreeResponse.json() : null;
  const obsidianTargetPath = 'ai创作短剧/韩剧制作/资产库.md';
  console.log('OBSIDIAN_TREE ' + JSON.stringify(obsidianTree ? {
    available: obsidianTree.available,
    rootName: obsidianTree.rootName,
    stats: obsidianTree.stats,
  } : null));
  check(obsidianTreeResponse.status() === 200 && obsidianTree && obsidianTree.available, 'Obsidian 目录树不可用');
  check(obsidianTree && JSON.stringify(obsidianTree.tree).includes(obsidianTargetPath), 'Obsidian 目录树缺少资产库.md');

  const obsidianNoteResponse = await page.request.get(`${BASE_URL}/api/obsidian/note?p=${encodeURIComponent(obsidianTargetPath)}`);
  const obsidianNote = obsidianNoteResponse.ok() ? await obsidianNoteResponse.json() : null;
  console.log('OBSIDIAN_NOTE ' + JSON.stringify(obsidianNote ? {
    name: obsidianNote.name,
    resolvedEmbeds: obsidianNote.resolvedEmbeds,
    unresolvedEmbeds: obsidianNote.unresolvedEmbeds,
  } : null));
  check(obsidianNoteResponse.status() === 200 && obsidianNote && obsidianNote.name === '资产库', 'Obsidian 资产库笔记读取失败');
  check(obsidianNote && obsidianNote.resolvedEmbeds > 0 && obsidianNote.unresolvedEmbeds === 0,
    'Obsidian 粘贴图片没有全部解析成功');
  check(obsidianNote && obsidianNote.content.includes('韩秀雅'), 'Obsidian 笔记原始文本顺序没有保留');

  const obsidianImageMatch = obsidianNote && obsidianNote.content.match(/\/api\/obsidian\/file\?p=([^" ]+)/);
  check(obsidianImageMatch, 'Obsidian 笔记没有生成本地图片地址');
  if (obsidianImageMatch) {
    const imageResponse = await page.request.get(`${BASE_URL}/api/obsidian/file?p=${obsidianImageMatch[1]}`, {
      headers: { Range: 'bytes=0-31' },
    });
    check(imageResponse.status() === 206, 'Obsidian 图片 Range 请求不是 206');
    check((imageResponse.headers()['content-type'] || '').startsWith('image/'), 'Obsidian 图片 MIME 不正确');
    check((await imageResponse.body()).length === 32, 'Obsidian 图片 Range 长度不正确');
  }

  for (const relPath of ['../../AppData/Roaming/obsidian/obsidian.json', '.obsidian/app.json']) {
    const blocked = await page.request.get(`${BASE_URL}/api/obsidian/file?p=${encodeURIComponent(relPath)}`);
    check(blocked.status() === 404, `Obsidian 越权路径 ${relPath} 没有被阻止`);
  }
  const obsidianWrite = await page.request.post(BASE_URL + '/api/obsidian/tree', { data: '{}' });
  check(obsidianWrite.status() === 405, 'Obsidian 只读 API 接受了写请求');

  // Obsidian 已从侧栏移除：经全局搜索面板的「Obsidian 笔记」条目打开
  await page.locator('#tbSearch').fill('资产库');
  await page.locator('#spResults .sp-item', { hasText: '笔记' }).first().waitFor({ state: 'visible', timeout: 5000 });
  console.log('OBS-PALLET', JSON.stringify(await page.locator('#spResults .sp-item').allTextContents()));
  await page.locator('#spResults .sp-item', { hasText: '笔记' }).first().click();
  await page.locator('.obsidian-app').waitFor({ state: 'visible' });
  await page.waitForTimeout(600);
  check(await page.locator('.obsidian-brand h2').textContent() === obsidianTree.rootName, 'Obsidian Vault 名称未显示');
  check(await page.locator('[data-app-count="obsidian"]').count() === 0, '侧栏移除后 Obsidian 计数徽标不应残留');
  const currentObsidianEntries = await page.locator('.obsidian-entry-name').allTextContents();
  check(currentObsidianEntries.includes('资产库'), 'Obsidian 打开后没有列出资产库条目');
  check(await page.locator('.obsidian-breadcrumb .obsidian-crumb').count() >= 2, 'Obsidian 面包屑没有体现层级关系');

  await page.locator('.obsidian-entry.note', { hasText: '资产库' }).click();
  await page.locator('.obsidian-viewer-head h2', { hasText: '资产库' }).waitFor();
  await page.waitForFunction(() => {
    const images = Array.from(document.querySelectorAll('.obsidian-note-body img'));
    return images.length > 0 && images.every(image => image.complete && image.naturalWidth > 0);
  }, null, { timeout: 15000 });
  check(await page.locator('.obsidian-note-body').textContent().then(text => text.includes('韩秀雅')),
    'Obsidian 资产库正文未按原内容展示');
  check(await page.locator('.obsidian-note-body img').count() === obsidianNote.resolvedEmbeds,
    '网站中的 Obsidian 图片数量与笔记解析结果不一致');

  await page.locator('.obsidian-search').fill('色卡');
  const obsidianSearchNames = await page.locator('.obsidian-entry-name').allTextContents();
  check(obsidianSearchNames.includes('色卡'), 'Obsidian 文件名搜索找不到色卡');

  const audioFiles = scanPayload ? scanPayload.files.filter(file => file.type === 'audio') : [];
  const regularAudio = audioFiles.filter(file => !file.hidden);
  const hiddenAudio = audioFiles.find(file => file.hidden);
  const expectedFolders = new Map();
  for (const file of audioFiles) {
    const folder = parentFolder(file.path);
    expectedFolders.set(folder, (expectedFolders.get(folder) || 0) + 1);
  }
  await page.locator('.side-nav-item[data-app="audio"]').click();
  await page.locator('.audio-app').waitFor({ state: 'visible' });
  const audioRows = page.locator('.audio-list .audio-row');
  const folderButtons = page.locator('.audio-folders .audio-folder');
  const audioSearch = page.locator('.audio-toolbar input[placeholder="搜索音频…"]');
  const audioSort = page.locator('.audio-toolbar select[aria-label="音频排序"]');
  const analysisToggle = page.locator('.audio-toolbar button[title*="分析目录"]');
  console.log('AUDIO_DEFAULT ' + JSON.stringify({
    scanned: audioFiles.length,
    regular: regularAudio.length,
    hidden: audioFiles.length - regularAudio.length,
    rows: await audioRows.count(),
    folders: await folderButtons.count(),
  }));
  check(await audioSearch.count() === 1, '音频搜索控件不存在或重复');
  check(await audioSort.count() === 1, '音频排序控件不存在或重复');
  check(await audioSort.locator('option').count() === 2, '音频排序选项数量不正确');
  check(await page.locator('.audio-toolbar button', { hasText: '导入音频' }).count() === 1,
    '音频库工具栏缺少直接导入入口');
  check(await page.locator('.audio-toolbar button', { hasText: '文件夹索引' }).count() === 1,
    '音频库工具栏缺少文件夹索引入口');

  if (!audioFiles.length) {
    check(await audioRows.count() === 0, '专用素材库没有音频时仍显示音频行');
    check((await page.locator('.audio-empty').textContent()).includes('还没有音频素材'), '空音频库没有提示正确的放置目录');
    check(await page.locator('.audio-empty button', { hasText: '选择音频导入' }).count() === 1, '空音频库缺少导入引导按钮');
    check((await page.locator('.audio-hero-copy').textContent()).includes('音频素材'), '音频库缺少标题说明');
  } else {
  check(await audioRows.count() === audioFiles.length, '音频库默认未收集全部扫描音频');
  check(await page.locator('.audio-row.analysis-audio').count() === audioFiles.filter(file => file.hidden).length,
    '音频库分析目录音频标记数量不正确');
  check(await folderButtons.count() === expectedFolders.size + 1, '父目录按钮数量不等于实际父目录数加“全部文件夹”');

  const folderButtonState = await folderButtons.evaluateAll(buttons => buttons.map(button => ({
    title: button.title,
    label: button.querySelector('.audio-folder-name')?.textContent || '',
    count: Number(button.querySelector('b')?.textContent || NaN),
  })));
  check(folderButtonState[0] && folderButtonState[0].label === '全部文件夹' && folderButtonState[0].count === audioFiles.length,
    '“全部文件夹”按钮数量不正确');
  for (const [folder, expectedCount] of expectedFolders) {
    const buttonState = folderButtonState.find(item => item.title === folder);
    check(buttonState && buttonState.count === expectedCount, `父目录按钮 ${folder} 的数量不正确`);
  }

  for (let index = 1; index < await folderButtons.count(); index++) {
    const selectedFolder = await folderButtons.nth(index).getAttribute('title');
    await folderButtons.nth(index).click();
    const visiblePaths = await page.locator('.audio-row .audio-path').allTextContents();
    check(visiblePaths.length === expectedFolders.get(selectedFolder), `父目录 ${selectedFolder} 筛选数量不正确`);
    check(visiblePaths.every(filePath => parentFolder(filePath) === selectedFolder),
      `父目录 ${selectedFolder} 筛选混入其他目录音频`);
  }
  await folderButtons.first().click();

  check(await page.locator('.audio-row .audio-player').count() === audioFiles.length, '并非每条音频都有播放器');
  await page.waitForFunction(() => {
    const players = Array.from(document.querySelectorAll('.audio-row .audio-player'));
    return players.length > 0 && players.every(player => player.readyState >= 1 || player.error);
  }, null, { timeout: 10000 });
  const audioMediaState = await page.locator('.audio-row .audio-player').evaluateAll(players => players.map(player => ({
    readyState: player.readyState,
    duration: Number.isFinite(player.duration) ? player.duration : null,
    errorCode: player.error ? player.error.code : null,
  })));
  console.log('AUDIO_MEDIA_STATE ' + JSON.stringify(audioMediaState));
  check(audioMediaState.every(state => state.readyState >= 1 && state.duration > 0 && state.errorCode === null),
    '至少一个音频播放器无法读取有效媒体时长');
  await page.locator('.audio-row .audio-row-actions button', { hasText: '详情' }).first().click();
  check(await page.locator('#lightbox').isVisible(), '点击音频详情后灯箱未打开');
  check(await page.locator('#lightbox #lbStage audio').count() === 1, '音频详情灯箱没有播放器');
  await page.locator('#lbClose').click();

  await analysisToggle.click();
  check(await analysisToggle.textContent() === '分析目录：已排除', '分析目录开关未切换为排除状态');
  check(await audioRows.count() === regularAudio.length, '排除分析目录后的音频数量不正确');
  check(await page.locator('.audio-row.analysis-audio').count() === 0, '排除后仍显示分析目录音频');
  check(await folderButtons.count() === new Set(regularAudio.map(file => parentFolder(file.path))).size + 1,
    '排除分析目录后父目录按钮数量不正确');

  if (hiddenAudio) {
    await page.locator('#tbSearch').fill(hiddenAudio.name);
    await page.waitForTimeout(500);
    const globalResults = page.locator('#spResults .sp-item');
    check(await page.locator('#searchPanel').isVisible(), '搜索隐藏分析音频时全局搜索面板未打开');
    check((await globalResults.allTextContents()).some(text => text.includes(hiddenAudio.name)),
      '全局搜索找不到隐藏分析目录音频');
    await page.keyboard.press('Escape');
  }
  }

  for (const relPath of [
    '视频制作OS/app.js',
    '视频制作OS/data/agent-knowledge.json',
    '../AGENTS.md',
    '素材库/女主 正脸.png',
    'evidence/VIDEO-013_BV1eoLs6NE4C/key_climax_239-340.mp4',
  ]) {
    const apiResponse = await page.request.get(`${BASE_URL}/api/file?p=${encodeURIComponent(relPath)}`);
    console.log(`FILE ${JSON.stringify(relPath)} status=${apiResponse.status()} length=${(await apiResponse.body()).length}`);
    check(apiResponse.status() === 404, `${relPath} 不应由 /api/file 暴露`);
  }

  const docFile = scanPayload && scanPayload.docs && scanPayload.docs[0];
  const videoFile = indexedVideos[0];
  if (docFile) {
    const docResponse = await page.request.get(`${BASE_URL}/api/doc?p=${encodeURIComponent(docFile.path)}`);
    console.log(`DOC ${JSON.stringify(docFile.path)} status=${docResponse.status()} content_length=${(await docResponse.text()).length}`);
    check(docResponse.status() === 200, '正常文档读取不是 200');
  } else {
    failures.push('扫描结果没有可用于验证的文档');
  }
  const nonDocResponse = await page.request.get(`${BASE_URL}/api/doc?p=${encodeURIComponent('视频制作OS/app.js')}`);
  console.log(`DOC_NON_DOC status=${nonDocResponse.status()}`);
  check(nonDocResponse.status() === 404, '/api/doc 不应读取 JS');
  const staticDataResponse = await page.request.get(`${BASE_URL}/data/agent-knowledge.json`);
  console.log(`STATIC_DATA status=${staticDataResponse.status()}`);
  check(staticDataResponse.status() === 404, 'data 目录不应由静态路由暴露');

  if (videoFile) {
    const suffixLength = Math.min(4, videoFile.size);
    const rangeResponse = await page.request.get(`${BASE_URL}/api/file?p=${encodeURIComponent(videoFile.path)}`, {
      headers: { Range: `bytes=-${suffixLength}` },
    });
    console.log(`RANGE ${JSON.stringify(videoFile.path)} status=${rangeResponse.status()} content_range=${rangeResponse.headers()['content-range'] || ''} length=${(await rangeResponse.body()).length}`);
    check(rangeResponse.status() === 206, 'Range 请求不是 206');
    check((await rangeResponse.body()).length === suffixLength, 'Range 后缀长度不正确');
  } else {
    check(indexedVideos.length === 0 && (await page.locator('.assets-grid .empty-tip').textContent()).includes('可索引的图片或视频'),
      '媒体来源没有视频时，页面没有进入正确的空索引状态');
  }

  for (const endpoint of ['/api/knowledge', '/api/meta', '/api/annotations']) {
    const started = Date.now();
    const unsupported = await page.request.fetch(BASE_URL + endpoint, {
      method: 'PUT', data: '{}', headers: { 'Content-Type': 'application/json' }, timeout: 1500,
    });
    const elapsed = Date.now() - started;
    console.log(`PUT ${endpoint} status=${unsupported.status()} elapsed_ms=${elapsed}`);
    check(unsupported.status() === 405, `${endpoint} PUT 没有返回 405`);
    check(elapsed < 1500, `${endpoint} PUT 超时或挂起`);
  }

  const badJson = await page.request.post(BASE_URL + '/api/meta', {
    data: 'not-json',
    headers: { 'Content-Type': 'application/json' },
  });
  console.log(`POST /api/meta invalid_json status=${badJson.status()} body=${JSON.stringify((await badJson.text()).slice(0, 120))}`);
  check(badJson.status() === 400, '非法 JSON 没有返回 400');

  const sanitizeResult = await page.evaluate(() => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    renderMD('<script>window.__markdown_script__=true</script><img src="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=" onerror="alert(1)"><a href="javascript:alert(1)">bad</a>', box);
    const result = {
      scripts: box.querySelectorAll('script').length,
      eventAttributes: Array.from(box.querySelectorAll('*')).filter(el => Array.from(el.attributes).some(attr => attr.name.toLowerCase().startsWith('on'))).length,
      javascriptLinks: Array.from(box.querySelectorAll('a')).filter(el => (el.getAttribute('href') || '').toLowerCase().startsWith('javascript:')).length,
    };
    box.remove();
    return result;
  });
  console.log('MARKDOWN_SANITIZE ' + JSON.stringify(sanitizeResult));
  check(sanitizeResult.scripts === 0 && sanitizeResult.eventAttributes === 0 && sanitizeResult.javascriptLinks === 0, 'Markdown 主动内容未清理');

  check(path.resolve(testDataDir) !== path.resolve(__dirname, 'data'), '浏览器测试错误地回退到正式 data 目录');
  check(serverOutput.includes(`OS 数据目录：${path.resolve(testDataDir)}`), '浏览器测试服务没有使用临时 SQLite 目录');

  for (const mobileWidth of [760, 375, 320]) {
    await page.setViewportSize({ width: mobileWidth, height: 900 });
    check(await page.locator('#menuBtn').isVisible(), `${mobileWidth}px 窗口没有显示侧栏菜单按钮`);
    await page.locator('#menuBtn').click();
    check(await page.locator('#sidebar').evaluate(el => el.classList.contains('open')), `${mobileWidth}px 菜单按钮没有打开侧栏抽屉`);
    check(await page.locator('#menuBtn').getAttribute('aria-expanded') === 'true', `${mobileWidth}px 菜单 aria-expanded 未同步`);
    await page.locator('.side-nav-item[data-app="overview"]').click();
    check(!(await page.locator('#sidebar').evaluate(el => el.classList.contains('open'))), `${mobileWidth}px 选择模块后侧栏抽屉没有关闭`);
    check(await page.locator('#menuBtn').getAttribute('aria-expanded') === 'false', `${mobileWidth}px 关闭后 aria-expanded 未复位`);
    const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(mobileOverflow <= 1, `${mobileWidth}px 窗口出现整页横向滚动（${mobileOverflow}px）`);
  }

  // 给媒体请求的异步错误事件留出稳定时间，避免关闭浏览器时才入队。
  await page.waitForTimeout(300);
  await page.context().close().catch(error => failures.push(`浏览器上下文关闭失败：${error.message}`));
  const browserClosed = await Promise.race([
    browser.close().then(() => true).catch(() => false),
    new Promise(resolve => setTimeout(() => resolve(false), 4000)),
  ]);
  if (!browserClosed) console.log('BROWSER_CLOSE_TIMEOUT true（测试进程将强制退出并回收子进程）');
  activeBrowser = null;
  const unexpectedConsoleErrors = consoleErrors.filter(message => !/status of 409 \(Conflict\)/.test(message));
  console.log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors));
  console.log('PAGE_ERRORS ' + JSON.stringify(pageErrors));
  console.log('BROWSER_HTTP_ERRORS ' + JSON.stringify(browserHttpErrors));
  if (failures.length) console.log('FAILURES ' + JSON.stringify(failures));
  return unexpectedConsoleErrors.length || pageErrors.length || failures.length ? 1 : 0;
}

main().then(code => finish(code)).catch(async error => {
  console.error(error);
  await finish(1);
});
