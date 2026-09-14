'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { ensureCreativeAssetRoot } = require('./creative-assets.cjs');

const artifactsRoot = path.resolve(__dirname, 'test-artifacts');
const runRoot = path.join(artifactsRoot, `media-import-${process.pid}-${Date.now()}`);
const projectRoot = path.join(runRoot, 'project');
const obsidianRoot = path.join(runRoot, 'obsidian');
const testDataDir = path.join(runRoot, 'data');
const requestedPort = 38400 + (process.pid % 500);

function safeCleanup() {
  const resolved = path.resolve(runRoot);
  assert.ok(resolved.startsWith(artifactsRoot + path.sep), '拒绝清理测试产物目录以外的路径');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待测试服务器超时：\n${output}`)), 12000);
    const onData = chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ baseUrl: `http://127.0.0.1:${match[1]}`, output });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`测试服务器提前退出（${code}）：\n${output}`));
    });
  });
}

function request(baseUrl, route, { method = 'GET', body = null, headers = {}, autoContentLength = true } = {}) {
  const target = new URL(route, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(target, {
      method,
      headers: {
        ...(body && autoContentLength ? { 'Content-Length': body.length } : {}),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        try { payload = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, payload, text });
      });
    });
    req.once('error', reject);
    if (body) req.end(body);
    else req.end();
  });
}

function abortImport(baseUrl) {
  const target = new URL('/api/import-media?kind=video&name=中断上传.mp4', baseUrl);
  return new Promise(resolve => {
    const req = http.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': 4096,
        Origin: baseUrl,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    req.once('error', done);
    req.once('close', done);
    req.write(Buffer.alloc(128), () => req.destroy());
  });
}

async function importMedia(baseUrl, kind, name, bytes, origin = baseUrl) {
  return request(baseUrl, `/api/import-media?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      Origin: origin,
      'Sec-Fetch-Site': origin === baseUrl ? 'same-origin' : 'cross-site',
    },
  });
}

async function postJson(baseUrl, route, value, origin = baseUrl) {
  const body = Buffer.from(JSON.stringify(value));
  return request(baseUrl, route, {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': origin === baseUrl ? 'same-origin' : 'cross-site',
    },
  });
}

async function importCreativeAsset(baseUrl, folder, name, bytes, origin = baseUrl) {
  return request(baseUrl, `/api/creative-assets/import?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: bytes,
    headers: {
      'Content-Type': 'application/octet-stream',
      Origin: origin,
      'Sec-Fetch-Site': origin === baseUrl ? 'same-origin' : 'cross-site',
    },
  });
}

async function main() {
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(obsidianRoot, { recursive: true });
  fs.mkdirSync(testDataDir, { recursive: true });
  assert.notEqual(path.resolve(testDataDir), path.resolve(__dirname, 'data'), '媒体导入测试不得使用正式 data 目录');
  const symlinkProject = path.join(runRoot, 'symlink-project');
  const outsideLibrary = path.join(runRoot, 'outside-library');
  fs.mkdirSync(symlinkProject, { recursive: true });
  fs.mkdirSync(outsideLibrary, { recursive: true });
  try {
    fs.symlinkSync(outsideLibrary, path.join(symlinkProject, '创作资产库'), 'dir');
    assert.throws(
      () => ensureCreativeAssetRoot(path.join(symlinkProject, '创作资产库')),
      /符号链接/,
      '创作资产库根符号链接没有被拒绝',
    );
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
  const child = spawn(process.execPath, ['server.js', '--port', String(requestedPort)], {
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

  try {
    const { baseUrl, output } = await waitForServer(child);
    assert.ok(output.includes(`OS 数据目录：${path.resolve(testDataDir)}`), '媒体导入测试服务没有确认隔离 SQLite 目录');
    const production = await request(baseUrl, '/api/production');
    assert.equal(production.status, 200, production.text);
    assert.equal(production.payload.available, true, '媒体导入测试没有在隔离目录内建立制作台账');

    const projectCreate = await postJson(baseUrl, '/api/creative-projects', { action: 'create', name: '校园心动' });
    assert.equal(projectCreate.status, 201, projectCreate.text);
    const project = projectCreate.payload.project;
    assert.ok(project?.id && projectCreate.payload.activeProjectId === project.id);
    const categoryPath = id => project.categories.find(category => category.id === id)?.path;
    const characterPath = categoryPath('characters');
    const audioPath = categoryPath('audio');
    const videoPath = categoryPath('references');
    const documentPath = categoryPath('documents');
    assert.ok(characterPath && audioPath && videoPath && documentPath, '新剧本没有建立标准资产分类');
    const characterFolder = await postJson(baseUrl, `/api/creative-assets/folder?project=${encodeURIComponent(project.id)}`, { parent: characterPath, name: '核心人物' });
    assert.equal(characterFolder.status, 201, characterFolder.text);
    assert.equal(characterFolder.payload.folder.path, `${characterPath}/核心人物`);
    const duplicateFolder = await postJson(baseUrl, `/api/creative-assets/folder?project=${encodeURIComponent(project.id)}`, { parent: characterPath, name: '核心人物' });
    assert.equal(duplicateFolder.status, 409, duplicateFolder.text);

    const imageBytes = Buffer.from('fake-png-content');
    const creativeImage = await importCreativeAsset(baseUrl, characterPath, '女主正脸.png', imageBytes);
    assert.equal(creativeImage.status, 201, creativeImage.text);
    assert.equal(creativeImage.payload.type, 'image');
    // 图片导入自动按“分类-序号”重命名（顺序命名功能）
    assert.equal(creativeImage.payload.name, '人物资产-001.png', creativeImage.text);
    assert.equal(creativeImage.payload.path, `${characterPath}/人物资产-001.png`);
    const creativeImageCollision = await importCreativeAsset(baseUrl, characterPath, '女主正脸.png', imageBytes);
    assert.equal(creativeImageCollision.status, 201, creativeImageCollision.text);
    assert.equal(creativeImageCollision.payload.name, '人物资产-002.png');
    const creativeAudio = await importCreativeAsset(baseUrl, audioPath, '女主声线.wav', Buffer.from('fake-wav-content'));
    assert.equal(creativeAudio.status, 201, creativeAudio.text);
    assert.equal(creativeAudio.payload.type, 'audio');
    const creativeVideo = await importCreativeAsset(baseUrl, videoPath, '走廊参考.mp4', Buffer.from('fake-video-content'));
    assert.equal(creativeVideo.status, 201, creativeVideo.text);
    assert.equal(creativeVideo.payload.type, 'video');
    const creativeDoc = await importCreativeAsset(baseUrl, documentPath, '资产说明.md', Buffer.from('# 资产说明'));
    assert.equal(creativeDoc.status, 201, creativeDoc.text);
    assert.equal(creativeDoc.payload.type, 'document');

    const rootUpload = await importCreativeAsset(baseUrl, '', '根目录.png', imageBytes);
    assert.equal(rootUpload.status, 403, rootUpload.text);
    const hiddenUpload = await importCreativeAsset(baseUrl, characterPath, '.隐藏.png', imageBytes);
    assert.equal(hiddenUpload.status, 400, hiddenUpload.text);
    const unsupportedUpload = await importCreativeAsset(baseUrl, characterPath, '危险页面.html', Buffer.from('<script>bad</script>'));
    assert.equal(unsupportedUpload.status, 415, unsupportedUpload.text);
    const crossSiteCreative = await importCreativeAsset(baseUrl, characterPath, '跨站.png', imageBytes, 'https://evil.example');
    assert.equal(crossSiteCreative.status, 403, crossSiteCreative.text);

    const creativeTree = await request(baseUrl, '/api/creative-assets');
    assert.equal(creativeTree.status, 200, creativeTree.text);
    assert.equal(creativeTree.payload.stats.image, 2);
    assert.equal(creativeTree.payload.stats.audio, 1);
    assert.equal(creativeTree.payload.stats.video, 1);
    assert.equal(creativeTree.payload.stats.document, 1);
    assert.ok(JSON.stringify(creativeTree.payload.tree).includes(`${characterPath}/人物资产-001.png`));
    assert.equal(JSON.stringify(creativeTree.payload.tree).includes(projectRoot), false, '资产树泄露了绝对路径');
    const staleProjectRead = await request(baseUrl, '/api/creative-assets?project=inspiration');
    assert.equal(staleProjectRead.status, 409, '旧工作台仍能读取另一个剧本的资产树');

    const creativePreview = await request(baseUrl, `/api/creative-assets/file?project=${encodeURIComponent(project.id)}&p=${encodeURIComponent(`${characterPath}/人物资产-001.png`)}`, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(creativePreview.status, 206, creativePreview.text);
    assert.equal(creativePreview.text, imageBytes.subarray(0, 4).toString('utf8'));
    const creativeTraversal = await request(baseUrl, `/api/creative-assets/file?p=${encodeURIComponent('../outside.png')}`);
    assert.equal(creativeTraversal.status, 403, creativeTraversal.text);
    const creativeCrossSiteRead = await request(baseUrl, '/api/creative-assets', {
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(creativeCrossSiteRead.status, 403, creativeCrossSiteRead.text);
    const creativeDocBypass = await request(baseUrl, `/api/doc?p=${encodeURIComponent(`创作资产库/${documentPath}/资产说明.md`)}`);
    assert.equal(creativeDocBypass.status, 404, creativeDocBypass.text);

    const videoBytes = Buffer.from('fake-mp4-content');
    const audioBytes = Buffer.from('fake-mp3-content');

    const firstVideo = await importMedia(baseUrl, 'video', '镜头01.mp4', videoBytes);
    assert.equal(firstVideo.status, 201, firstVideo.text);
    assert.equal(firstVideo.payload.kind, 'video');
    assert.ok(firstVideo.payload.path.startsWith('素材库/手动导入/'));
    assert.deepEqual(fs.readFileSync(path.join(projectRoot, ...firstVideo.payload.path.split('/'))), videoBytes);

    const secondVideo = await importMedia(baseUrl, 'video', '镜头01.mp4', videoBytes);
    assert.equal(secondVideo.status, 201, secondVideo.text);
    assert.equal(secondVideo.payload.name, '镜头01 (2).mp4');

    const audio = await importMedia(baseUrl, 'audio', '对白01.mp3', audioBytes);
    assert.equal(audio.status, 201, audio.text);
    assert.equal(audio.payload.kind, 'audio');
    assert.deepEqual(fs.readFileSync(path.join(projectRoot, ...audio.payload.path.split('/'))), audioBytes);

    const wrongType = await importMedia(baseUrl, 'video', '角色图.png', Buffer.from('not-video'));
    assert.equal(wrongType.status, 415, wrongType.text);

    const crossSite = await importMedia(baseUrl, 'video', '跨站.mp4', videoBytes, 'https://evil.example');
    assert.equal(crossSite.status, 403, crossSite.text);

    const invalidHost = await request(baseUrl, '/api/import-media?kind=video&name=伪造主机.mp4', {
      method: 'POST',
      body: videoBytes,
      headers: {
        'Content-Type': 'application/octet-stream',
        Host: 'evil.example',
        Origin: 'http://evil.example',
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(invalidHost.status, 403, invalidHost.text);

    const missingLength = await request(baseUrl, '/api/import-media?kind=video&name=缺少长度.mp4', {
      method: 'POST',
      body: videoBytes,
      autoContentLength: false,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Transfer-Encoding': 'chunked',
        Origin: baseUrl,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(missingLength.status, 411, missingLength.text);

    const invalidKind = await request(baseUrl, '/api/import-media?kind=image&name=错误类型.mp4', {
      method: 'POST',
      body: videoBytes,
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: baseUrl,
        'Sec-Fetch-Site': 'same-origin',
      },
    });
    assert.equal(invalidKind.status, 400, invalidKind.text);

    await abortImport(baseUrl);
    await new Promise(resolve => setTimeout(resolve, 200));

    const scan = await request(baseUrl, '/api/scan');
    assert.equal(scan.status, 200, scan.text);
    // scan 现在会合并“创作工作台”内置来源（@media/creative-assets token），手动导入断言只数素材库本体。
    const projectVideos = scan.payload.files.filter(file => file.type === 'video' && file.path.startsWith('素材库/'));
    const projectAudios = scan.payload.files.filter(file => file.type === 'audio' && file.path.startsWith('素材库/'));
    assert.equal(projectVideos.length, 2);
    assert.equal(projectAudios.length, 1);
    const workbenchSource = (scan.payload.sources || []).find(source => source.id === 'creative-assets');
    assert.equal(workbenchSource?.available, true, 'scan 没有返回内置创作工作台媒体来源');
    assert.ok(scan.payload.files.some(file => file.path.startsWith('@media/creative-assets/')), 'scan 没有合并创作工作台媒体');

    const importedRoot = path.join(projectRoot, '素材库', '手动导入');
    const remainingParts = fs.readdirSync(importedRoot, { recursive: true })
      .filter(entry => String(entry).endsWith('.part'));
    assert.deepEqual(remainingParts, [], '导入结束后遗留了临时文件');
    console.log('MEDIA_IMPORT PASS: creative asset hierarchy/media preview plus video/audio import, validation and cleanup');
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise(resolve => child.exitCode === null ? child.once('exit', resolve) : resolve());
    safeCleanup();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
