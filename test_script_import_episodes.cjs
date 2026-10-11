'use strict';

// Headless browser regression. All server data and browser storage are temporary.
// Optional real source: DOCX_TEST_FILE=/absolute/source.docx node this-file.cjs
// OOXML oracle: DOCX_TEST_PYTHON=/path/to/python3 (stdlib only).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('playwright');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceFile = process.argv[2] || process.env.DOCX_TEST_FILE || '';
const python = process.env.DOCX_TEST_PYTHON || 'python3';
const oracleCode = String.raw`
import sys,json,zipfile,xml.etree.ElementTree as ET,re,base64,io
source=json.loads(sys.stdin.read())['source']
ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
if source:
    raw=open(source,'rb').read()
else:
    paragraphs=[]
    for i in range(1,11):
        paragraphs += [f'第 {i} 集',f'{i}-1 内景 日',f'角色：第{i+1}集里面还有戏。',f'正文 {i}：全角１２３、& < >、emoji🎬。']
    root=ET.Element('{'+ns+'}document')
    body=ET.SubElement(root,'{'+ns+'}body')
    for text in paragraphs:
        node=ET.SubElement(ET.SubElement(ET.SubElement(body,'{'+ns+'}p'),'{'+ns+'}r'),'{'+ns+'}t')
        node.text=text
    ET.register_namespace('w',ns)
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr('word/document.xml',ET.tostring(root,encoding='utf-8',xml_declaration=True))
    raw=stream.getvalue()
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    assert z.testzip() is None
    document=ET.fromstring(z.read('word/document.xml'))
paragraphs=[]
for paragraph in document.iter('{'+ns+'}p'):
    fragments=[]
    for node in paragraph.iter():
        if node.tag == '{'+ns+'}t': fragments.append(node.text or '')
        elif node.tag == '{'+ns+'}tab': fragments.append('\t')
        elif node.tag in ('{'+ns+'}br','{'+ns+'}cr'): fragments.append('\n')
    paragraphs.append(''.join(fragments))
headings=[(i,int(match.group(1))) for i,text in enumerate(paragraphs)
          if (match:=re.fullmatch(r'第\s*(\d+)\s*集',text.strip())) and int(match.group(1)) > 0]
assert [number for _,number in headings] == list(range(1,11)), 'Source must have exactly 第 1 集 through 第 10 集'
if headings[0][0] > 0:
    assert any(re.fullmatch(r'第\s*0\s*集',text.strip()) or text.strip() in ('目录','剧本大纲','正文','正文开始')
               for text in paragraphs[:headings[0][0]]), 'Unrecognized preamble; review the independent oracle explicitly'
chunks=[]
for index,(start,number) in enumerate(headings):
    end=headings[index+1][0] if index+1<len(headings) else len(paragraphs)
    chunks.append({'title':paragraphs[start].strip(),'text':'\n'.join(paragraphs[start:end]).strip(),
                   'startParagraph':start,'endParagraph':end})
print(json.dumps({'bytes':base64.b64encode(raw).decode(),'text':'\n'.join(paragraphs).strip(),
                  'bodyText':'\n'.join(paragraphs[headings[0][0]:]).strip(),
                  'excludedPrefixParagraphCount':headings[0][0],
                  'paragraphCount':len(paragraphs),'chunks':chunks},ensure_ascii=False))
`;

function docxOracle() {
  const result = spawnSync(python, ['-X', 'utf8', '-c', oracleCode], {
    input: JSON.stringify({ source: sourceFile }), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || 'OOXML oracle failed'));
  const oracle = JSON.parse(result.stdout);
  oracle.raw = Buffer.from(oracle.bytes, 'base64');
  delete oracle.bytes;
  return oracle;
}

async function unusedPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  assert.ok(port !== 3750 && port !== 3751, 'Refuse a formal/candidate port');
  return port;
}

function waitForServer(child, port, dataRoot) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Isolated server timed out: ' + output)), 15000);
    const read = chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      try {
        assert.equal(Number(match[1]), port, 'Server used an unexpected port');
        assert.ok(output.includes('OS 数据目录：' + fs.realpathSync.native(dataRoot)), 'Server did not confirm isolated data: ' + output);
        resolve();
      } catch (error) { reject(error); }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Isolated server exited: ' + code)); });
  });
}

function installBridge(context, project) {
  return context.addInitScript(project => {
    const service = { id: 'gpt', label: 'GPT', imageLabel: 'GPT 图片', videoLabel: 'GPT 提示词', url: 'about:blank' };
    const browser = mode => ({ mode, serviceId: 'gpt', tabs: [], url: 'about:blank', loading: false });
    const api = {
      getConfig: async () => ({ project, services: [service], modeServices: { image: ['gpt'], video: ['gpt'] },
        defaults: { image: 'gpt', video: 'gpt' }, paths: { creativeAssetAvailable: true }, browser: browser('image') }),
      getDownloads: async () => [], setMode: async mode => browser(mode),
      setAssetPanel: async patch => ({ ...patch, creativeAssetAvailable: true }),
    };
    window.creatorAPI = new Proxy(api, { get: (target, key) => key in target ? target[key]
      : String(key).startsWith('on') ? () => () => {} : async () => undefined });
    // The native browser bridge and unrelated SSE are fixtures; importer, DOM and storage are production code.
    window.EventSource = class { addEventListener() {} close() {} };
  }, project);
}

const expectedItems = chunks => chunks.map(({ title, text }) => ({ title, text }));
const persistedGroups = page => page.evaluate(() => {
  const saved = JSON.parse(localStorage.getItem('videoOS.creator.project.v2.' + state.projectId));
  return saved.scripts.groups;
});
const comparableGroups = groups => groups.map(group => ({ name: group.name, items: expectedItems(group.items) }));

async function dropFile(page, bytes, name, expectedGroupCount) {
  await page.evaluate(({ encoded, name }) => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const file = new File([bytes], name, { type: name.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const panel = document.querySelector('#scriptAccordion');
    panel.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    panel.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, { encoded: bytes.toString('base64'), name });
  await page.waitForFunction(count => state.scripts.groups.length === count
    && state.scripts.groups.at(-1).items.length > 0, expectedGroupCount);
  const groups = await persistedGroups(page);
  assert.equal(groups.length, expectedGroupCount, 'Real drop did not persist the new group');
  return groups.at(-1);
}

async function verifyRenderedDocx(page, group) {
  let renderedGroup = page.locator('.script-group').filter({ has: page.locator('[aria-label="分组名称"]', { hasText: group.name }) });
  assert.equal(await renderedGroup.count(), 1, 'DOCX group missing from rendered DOM');
  if (await renderedGroup.locator('.script-group-toggle').getAttribute('aria-expanded') === 'false') {
    await renderedGroup.locator('.script-group-toggle').click();
  }
  assert.equal(await renderedGroup.locator('.script-item').count(), group.items.length, 'Rendered episode count differs');
  assert.deepEqual(await renderedGroup.locator('[aria-label="段落标题"]').allTextContents(), group.items.map(item => item.title));
  for (let index = 0; index < group.items.length; index++) {
    const item = renderedGroup.locator('.script-item').nth(index);
    await item.locator('.script-item-toggle').click();
    assert.equal(await renderedGroup.locator('.script-item').nth(index).locator('textarea[aria-label="剧本内容"]').inputValue(),
      group.items[index].text, 'Rendered episode body differs: ' + (index + 1));
  }
}

function matrixCases() {
  const pair = (id, first, second, newline = '\n') => ({ id,
    text: [first, '1-1 内景 日', '角色：我记得第2集里面的场景。', second, '2-1 外景 夜', '尾行🎬'].join(newline),
    chunks: [{ title: first.trim().replace(/^#+\s*/, '').replace(/[\u200b-\u200d\u2060\ufeff]/g, ''),
      text: [first, '1-1 内景 日', '角色：我记得第2集里面的场景。'].join('\n').trim() },
    { title: second.trim().replace(/^#+\s*/, '').replace(/[\u200b-\u200d\u2060\ufeff]/g, ''),
      text: [second, '2-1 外景 夜', '尾行🎬'].join('\n').trim() }] });
  const cases = [
    pair('arabic-compact', '第01集', '第02集'),
    pair('chinese-compact', '第一集', '第二集'),
    pair('ascii-spaces', '第 1 集', '第 2 集'),
    pair('tabs', '\t第\t1\t集', '\t第\t2\t集'),
    pair('fullwidth', '第　１　集', '第　２　集'),
    pair('numeric-internal-spaces', '第 1 0 集', '第 1 1 集'),
    pair('chinese-internal-spaces', '第 十 一 集', '第 十 二 集'),
    pair('zero-width', '\ufeff第\u200b1\u2060集', '第\u200c2\u200d集'),
    pair('markdown', '## 第1集：开始', '### 第2集：结束'),
    pair('brackets', '【第1集】开始', '（第2集）结束'),
    pair('chapter-units', '第1话', '第二章'),
    pair('crlf', '第 1 集', '第 2 集', '\r\n'),
    pair('carriage-return', '第 1 集', '第 2 集', '\r'),
  ];
  for (const [id, text] of [
    ['single-episode', '第 1 集\n1-1 日\n只有这一集，保持单段。'],
    ['scene-numbers-only', '1-1 内景 日\n正文\n1-2 外景 夜\n正文\n2-1 外景 日'],
    ['dialogue-mentions', '角色：第1集真好看。\n“第2集，我想明天看。”\n第3集里面的演员我认识。\n那第4集呢？'],
    ['plain-single', '没有分集标题的短剧本\n段落一\n段落二'],
  ]) cases.push({ id, text, chunks: null });
  const withDialogues = pair('dialogue-with-real-headings', '第1集', '第2集');
  withDialogues.text = '第1集\n角色：第3集真好看。\n第4集里面还有戏。\n第2集\n角色：我们谈第5集。';
  withDialogues.chunks = [{ title: '第1集', text: '第1集\n角色：第3集真好看。\n第4集里面还有戏。' },
    { title: '第2集', text: '第2集\n角色：我们谈第5集。' }];
  cases.push(withDialogues);
  cases.push({ id: 'preamble-preserved-without-extra-episode', text: '剧名与人物表\n\n第1集\n正文甲\n第2集\n正文乙',
    chunks: [{ title: '第1集', text: '剧名与人物表\n\n第1集\n正文甲' },
      { title: '第2集', text: '第2集\n正文乙' }] });
  cases.push(...outlineCases());
  return cases;
}

function outlineCases() {
  const episodes = Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const title = `第 ${number} 集`;
    return { title, text: `${title}\n${number}-1 内景 日\n林青：保留正文首句 ${number}，不要改写。\n吴建：保留第二句。\n正文结尾 ${number}🎬` };
  });
  const body = episodes.map(episode => episode.text).join('\n\n');
  const summaries = episodes.map((_, index) => `【第 ${index + 1} 集】第 ${index + 1} 集的梗概，不是正文。`).join('\n');
  const cases = [
    { id: 'zero-outline-ten-summaries-ten-body',
      text: `剧名，不新建开头集\n第0集\n剧本大纲收购商遭遇村民争议。\n${summaries}\n正文开始\n${body}`, chunks: episodes },
    { id: 'toc-repeat-number-full-body',
      text: `目录\n${episodes.map((_, index) => `第 ${index + 1} 集\n${index + 2}`).join('\n')}\n${body}`, chunks: episodes },
    { id: 'toc-dot-leaders',
      text: `目录\n${episodes.map((_, index) => `第 ${index + 1} 集 开始…………${index + 2}`).join('\n')}\n剧本正文\n${body}`, chunks: episodes },
    { id: 'unlabelled-inline-summary-list', text: `${summaries}\n${body}`, chunks: episodes },
    { id: 'zero-outline-body-inferred-without-body-label',
      text: `第0集\n剧本大纲：概述\n${summaries}\n${body}`, chunks: episodes },
    { id: 'outline-plain-body-inferred-by-repeated-number',
      text: '剧情梗概\n【第1集】概述甲。\n【第2集】概述乙。\n第1集\n正文首段甲，不依赖场次。\n第2集\n正文首段乙，不依赖对白。',
      chunks: [{ title: '第1集', text: '第1集\n正文首段甲，不依赖场次。' }, { title: '第2集', text: '第2集\n正文首段乙，不依赖对白。' }] },
    { id: 'outline-only-do-not-invent-episodes', text: `剧本大纲\n第0集\n总体故事。\n${summaries}`, chunks: null },
    { id: 'inline-summary-only-do-not-invent-episodes', text: summaries, chunks: null },
    { id: 'toc-only-do-not-invent-episodes', text: '目录\n第1集 开始……1\n第2集 结束……9', chunks: null },
    { id: 'zero-outline-one-real-episode',
      text: '剧名\n第0集\n剧本大纲\n【第1集】概述。\n正文开始\n第1集\n1-1 内景\n正文首段。',
      chunks: [{ title: '第1集', text: '第1集\n1-1 内景\n正文首段。' }] },
    { id: 'same-number-continuation-preserves-first-paragraph',
      text: '第1集\n正文首段，不能因为下一块有场次就删掉。\n第1集 续\n1-2 夜\n正文续段。\n第2集\n2-1 日\n结尾。',
      chunks: [{ title: '第1集', text: '第1集\n正文首段，不能因为下一块有场次就删掉。\n\n第1集 续\n1-2 夜\n正文续段。' },
        { title: '第2集', text: '第2集\n2-1 日\n结尾。' }] },
    { id: 'inline-same-number-continuation-preserved',
      text: '【第1集】这是实际正文首句。\n第1集 续\n1-2 夜\n续段。\n第2集\n2-1 日\n正文乙。',
      chunks: [{ title: '【第1集】这是实际正文首句。', text: '【第1集】这是实际正文首句。\n\n第1集 续\n1-2 夜\n续段。' },
        { title: '第2集', text: '第2集\n2-1 日\n正文乙。' }] },
    { id: 'range-title-does-not-limit-actual-episodes', text: '第1-10集\n第11集\n11-1 日\n正文甲。\n第12集\n12-1 日\n正文乙。',
      chunks: [{ title: '第11集', text: '第1-10集\n\n第11集\n11-1 日\n正文甲。' },
        { title: '第12集', text: '第12集\n12-1 日\n正文乙。' }] },
    { id: 'late-outline-does-not-enter-episode-body',
      text: '第1集\n1-1 日\n正文首段。\n目录\n第1集 开始……1\n第2集 结束……5\n正文开始\n第2集\n2-1 日\n正文尾段。',
      chunks: [{ title: '第1集', text: '第1集\n1-1 日\n正文首段。' }, { title: '第2集', text: '第2集\n2-1 日\n正文尾段。' }] },
    { id: 'body-label-inside-episode-preserves-following-text',
      text: '第1集\n正文\n1-1 日\n正文首段。\n第2集\n剧本正文\n2-1 日\n正文尾段。',
      chunks: [{ title: '第1集', text: '第1集\n正文\n1-1 日\n正文首段。' },
        { title: '第2集', text: '第2集\n剧本正文\n2-1 日\n正文尾段。' }] },
  ];
  const fullwidth = '第　０　集\n剧本大纲\n【第　一　集】梗概甲。\n【第　二　集】梗概乙。\n正文开始\n第　１　集\n１-１ 日\n正文甲。\n第　二　集\n二号集正文乙。';
  cases.push({ id: 'outline-with-fullwidth-and-chinese-numbers', text: fullwidth,
    chunks: [{ title: '第　１　集', text: '第　１　集\n１-１ 日\n正文甲。' }, { title: '第　二　集', text: '第　二　集\n二号集正文乙。' }] });
  return cases;
}

async function main() {
  const oracle = docxOracle();
  const sourceHash = hash(oracle.raw);
  const creatorHash = hash(fs.readFileSync(path.join(__dirname, 'creator.js')));
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-script-import-'));
  const projectRoot = path.join(runRoot, 'project');
  const dataRoot = path.join(runRoot, 'data');
  const obsidianRoot = path.join(runRoot, 'obsidian');
  for (const dir of [projectRoot, dataRoot, obsidianRoot]) fs.mkdirSync(dir);
  let child;
  let context;
  let report;
  try {
    const port = await unusedPort();
    const base = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server.js', '--port', String(port)], { cwd: __dirname,
      env: { ...process.env, VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: dataRoot,
        OBSIDIAN_VAULT_PATH: obsidianRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForServer(child, port, dataRoot);
    const response = await fetch(base + '/api/creative-projects', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ action: 'create', name: '分集导入隔离测试' }) });
    assert.equal(response.status, 201, 'Failed to create isolated project');
    const { project } = await response.json();
    assert.ok(project.id);
    context = await chromium.launchPersistentContext(path.join(runRoot, 'profile'), {
      headless: true, viewport: { width: 1440, height: 1000 },
    });
    await installBridge(context, project);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/creator.html?mode=image&project=' + encodeURIComponent(project.id));
    await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('body').getAttribute('data-ready'), 'true', 'Creator failed to initialize');
    assert.equal((await persistedGroups(page)).length, 0, 'Isolated profile was not empty');
    const extracted = await page.evaluate(async encoded => {
      const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
      return extractDocxText(new File([bytes], 'source.docx'));
    }, oracle.raw.toString('base64'));
    assert.equal(extracted.trim(), oracle.text, 'Browser DOCX extraction differs from independent OOXML text');
    const actualChunks = await page.evaluate(text => splitScriptByEpisodes(text), extracted);
    assert.deepEqual(actualChunks, expectedItems(oracle.chunks), 'DOCX episode boundaries or content differ');
    // Each exact episode match plus whole non-whitespace sequence catches omissions/duplication and reassignment.
    const compact = text => text.replace(/\s/g, '');
    assert.equal(compact(actualChunks.map(item => item.text).join('\n')), compact(oracle.bodyText), 'DOCX body lost characters');
    const sourceScenes = oracle.bodyText.match(/^\s*\d+-\d+.*$/gm) || [];
    const importedScenes = actualChunks.flatMap(item => item.text.match(/^\s*\d+-\d+.*$/gm) || []);
    assert.deepEqual(importedScenes, sourceScenes, 'Scene numbers were lost/reordered');
    const docxGroup = await dropFile(page, oracle.raw, 'episode-source.docx', 1);
    assert.deepEqual(expectedItems(docxGroup.items), expectedItems(oracle.chunks), 'Drop importer altered DOCX contents');
    await verifyRenderedDocx(page, docxGroup);
    await page.reload();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(expectedItems((await persistedGroups(page))[0].items), expectedItems(oracle.chunks), 'DOCX reload lost persisted text');
    await verifyRenderedDocx(page, docxGroup);

    const matrix = matrixCases();
    for (let index = 0; index < matrix.length; index++) {
      const sample = matrix[index];
      const actual = await page.evaluate(text => splitScriptByEpisodes(text), sample.text);
      assert.deepEqual(actual, sample.chunks, 'Parser matrix failed: ' + sample.id);
      const imported = await dropFile(page, Buffer.from(sample.text), sample.id + '.txt', index + 2);
      const expected = sample.chunks || [{ title: sample.id, text: sample.text.replace(/\r\n/g, '\n').trim() }];
      assert.deepEqual(expectedItems(imported.items), expected, 'Real TXT drop failed: ' + sample.id);
    }
    const beforeReload = await persistedGroups(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    const afterReload = await persistedGroups(page);
    assert.deepEqual(afterReload, beforeReload, 'Reload changed imported group records');
    assert.deepEqual(await page.evaluate(() => state.scripts.groups), beforeReload, 'Reload did not restore actual workspace state');
    assert.equal(await page.locator('.script-group').count(), matrix.length + 1, 'Reload omitted rendered groups');
    assert.equal(errors.length, 0, 'Browser exceptions: ' + errors.join('; '));
    assert.equal(hash(fs.readFileSync(path.join(__dirname, 'creator.js'))), creatorHash, 'Parser changed during test; rerun frozen source');
    report = { passed: true, creatorSha256: creatorHash, sourceKind: sourceFile ? 'provided-docx' : 'generated-docx',
      docxSha256Before: sourceHash, docxSha256After: sourceFile ? hash(fs.readFileSync(sourceFile)) : sourceHash,
      paragraphCount: oracle.paragraphCount, episodeCount: docxGroup.items.length,
      excludedPrefixParagraphCount: oracle.excludedPrefixParagraphCount,
      sourceSceneCount: sourceScenes.length, extractedCharacters: Array.from(oracle.text).length,
      legacyHeadingCount: oracle.text.split('\n').filter(line => /^\s*#?\s*第[0-9一二三四五六七八九十百千零两]+[集话回章]/.test(line)).length,
      episodes: oracle.chunks.map(chunk => ({ title: chunk.title, startParagraph: chunk.startParagraph,
        endParagraph: chunk.endParagraph, characters: Array.from(chunk.text).length, textSha256: hash(chunk.text) })),
      matrixCount: matrix.length, matrix: matrix.map(item => item.id), persistedGroupCount: afterReload.length,
      persistedItemCount: afterReload.reduce((sum, group) => sum + group.items.length, 0), browserExceptions: errors,
      verification: ['independent-OOXML-vs-browser-extraction', 'exact-per-episode-body-and-boundaries',
        'full-body-character-preservation', 'scene-number-preservation', 'real-DOM-drop', 'rendered-editor-values',
        'localStorage-persistence', 'reload-restores-workspace-and-rendered-groups'],
      scope: 'Isolated Chromium source page; native browser bridge fixture. No installed-app or formal/candidate session test.' };
    assert.equal(report.docxSha256After, report.docxSha256Before, 'Source DOCX changed');
  } finally {
    if (context) await context.close();
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 4000))]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    }
    assert.ok(path.basename(runRoot).startsWith('video-os-script-import-') && path.dirname(runRoot) === os.tmpdir());
    fs.rmSync(runRoot, { recursive: true, force: true });
    if (sourceFile) assert.equal(hash(fs.readFileSync(sourceFile)), sourceHash, 'Source DOCX changed during test/cleanup');
  }
  const evidenceFile = process.env.SCRIPT_IMPORT_EVIDENCE;
  if (evidenceFile) {
    fs.mkdirSync(path.dirname(path.resolve(evidenceFile)), { recursive: true });
    fs.writeFileSync(evidenceFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log('SCRIPT_IMPORT_EPISODES_PASS ' + JSON.stringify(report));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
