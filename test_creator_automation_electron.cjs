'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

if (!process.versions.electron) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-upload-e2e-'));
  const child = spawn(require('electron'), [__filename, root], { env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }, stdio: 'inherit' });
  const timeout = setTimeout(() => { child.kill(); process.exitCode = 1; }, 50000);
  child.on('exit', code => { clearTimeout(timeout); fs.rmSync(root, { recursive: true, force: true }); process.exitCode = code || 0; });
} else {
  const { app, BrowserWindow } = require('electron');
  const { createCreatorAutomation } = require('./electron/creator-automation.cjs');
  const { resolveCreativeAsset, classifyCreativeAsset } = require('./creative-assets.cjs');
  const root = process.argv[2];
  app.setPath('userData', path.join(root, 'user-data'));
  let server, win;
  app.whenReady().then(async () => {
    const assets = path.join(root, 'assets'); fs.mkdirSync(path.join(assets, 'fixture'), { recursive: true });
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(path.join(assets, 'fixture', '尾帧.png'), bytes);
    let received = null, submits = 0;
    server = http.createServer(async (req, res) => {
      if (req.url === '/upload') { const chunks = []; for await (const c of req) chunks.push(c); received = Buffer.concat(chunks); res.end('场景创建成功'); return; }
      if (req.url === '/submit') { submits++; res.end('task-123'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><div data-message-author-role="assistant"><pre>第十集原始提示词\n尾帧仅作参考\n不要生成音乐</pre></div>
        <input id="file" type="file" accept="image/png"><textarea aria-label="视频提示词"></textarea><button id="submit">生成视频</button><p id="receipt"></p>
        <script>file.addEventListener('change',async()=>{const response=await fetch('/upload',{method:'POST',body:file.files[0]});receipt.textContent=await response.text()});submit.onclick=async()=>{receipt.textContent=await(await fetch('/submit',{method:'POST'})).text()}</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await win.loadURL(url);
    let activeProject = { id: 'p', folder: 'fixture', name: '测试项目' };
    const controller = createCreatorAutomation({ directory: path.join(root, 'data'), allowLocal: true,
      getProject: () => activeProject, getState: () => ({ project: activeProject }), getTab: id => id === 'tab1' ? { id, view: { webContents: win.webContents } } : null,
      resolveAsset: p => { const found = resolveCreativeAsset(assets, p); if (!found || !p.startsWith('fixture/')) throw new Error('越界资产'); return { absolutePath: found.abs, type: classifyCreativeAsset(p) }; }, listAssets: () => [] });
    const binding = { projectId: 'p', tabId: 'tab1', expectedUrl: url };
    let snap = await controller.call('page_read', binding);
    assert.ok(snap.latestAssistant.text.endsWith('不要生成音乐')); assert.equal(snap.latestAssistant.streaming, false);
    const fileRef = snap.controls.find(c => c.type === 'file').ref;
    await assert.rejects(controller.call('asset_upload', { ...binding, snapshotId: snap.snapshotId, ref: fileRef, operationId: 'bad', paths: ['../outside.png'] }), /越界/);
    const upload = await controller.call('asset_upload', { ...binding, snapshotId: snap.snapshotId, ref: fileRef, operationId: 'upload1', paths: ['fixture/尾帧.png'] });
    assert.equal(upload.status, 'files_delivered'); assert.equal(upload.serverConfirmed, false);
    for (let i = 0; !received && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(received, bytes, '实际上传到 HTTP 端的文件必须逐字节一致');
    snap = await controller.call('page_read', binding); assert.ok(snap.text.includes('场景创建成功'));
    const textRef = snap.controls.find(c => c.tag === 'textarea').ref;
    const filled = await controller.call('page_act', { ...binding, snapshotId: snap.snapshotId, ref: textRef, operationId: 'fill1', action: 'fill', text: '中文提示词\n第二行' });
    assert.equal(filled.value, '中文提示词\n第二行');
    snap = await controller.call('page_read', binding);
    const clickArgs = { ...binding, snapshotId: snap.snapshotId, ref: snap.controls.find(c => c.label === '生成视频').ref, operationId: 'submit1', action: 'click' };
    await controller.call('page_act', clickArgs);
    const replay = await controller.call('page_act', clickArgs); assert.equal(replay.replayed, true);
    for (let i = 0; !submits && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(submits, 1);
    snap = await controller.call('page_read', binding);
    await win.loadURL(url);
    await assert.rejects(controller.call('page_act', { ...binding, snapshotId: snap.snapshotId, ref: textRef, operationId: 'stale', action: 'fill', text: '过期' }), /刷新/);
    await win.webContents.executeJavaScript(`document.body.innerHTML='<div contenteditable="true"><p>【素材】</p><p>沈浩人物资产：锁定脸。</p><p>楚涵人物资产：锁定脸。</p></div>'; const ed=document.querySelector('[contenteditable]'); ed.addEventListener('input',()=>{if(!ed.textContent.includes('@'))return;const range=getSelection().getRangeAt(0).cloneRange();const menu=document.createElement('div');menu.className='tippy-content';for(const name of ['沈浩','楚涵']){const b=document.createElement('button');b.textContent=name;b.onmousedown=e=>e.preventDefault();b.onclick=()=>{range.setStart(range.startContainer,range.startOffset-1);range.deleteContents();const tag=document.createElement('span');tag.contentEditable='false';tag.className='mention';tag.textContent=name;range.insertNode(tag);menu.remove()};menu.append(b)}document.body.append(menu)});`);
    let editor = await controller.call('editor_read', {...binding,includeText:true});
    const bindArgs={...binding,operationId:'inline1',revision:editor.revision,section:'【素材】',items:[{anchor:'沈浩人物资产',asset:'沈浩'},{anchor:'楚涵人物资产',asset:'楚涵'}]};
    const bound=await controller.call('editor_bind_inline',bindArgs);
    assert.equal(bound.status,'draft_verified');assert.equal(bound.submitted,false);assert.equal(bound.tags.length,2);
    assert.equal(submits,1,'绑定正文不得触发提交');
    assert.equal((await controller.call('editor_bind_inline',bindArgs)).replayed,true);
    editor=await controller.call('editor_read',binding);
    const again=await controller.call('editor_bind_inline',{...bindArgs,revision:editor.revision,operationId:'inline-again'});
    assert.ok(again.items.every(i=>i.status==='already_bound'));
    await assert.rejects(controller.call('editor_bind_inline',{...bindArgs,operationId:'stale-editor'}),/正文已变化/);
    await assert.rejects(controller.call('editor_bind_inline',{...bindArgs,revision:editor.revision,operationId:'missing-anchor',items:[{anchor:'不存在',asset:'沈浩'}]}),/定位文字/);
    console.log('INLINE_NATIVE_MENU_BATCH_IDEMPOTENT_NO_SUBMIT_PASS');
    activeProject = { id: 'other' };
    await assert.rejects(controller.call('page_read', binding), /项目已变化/);
    console.log('REAL_ELECTRON_FILE_UPLOAD_BYTES_PASS');
    console.log('PAGE_READ_FILL_REPLAY_STALE_PROJECT_PASS');
  }).then(() => { win?.destroy(); server?.close(); app.exit(0); }).catch(error => { console.error(error); win?.destroy(); server?.close(); app.exit(1); });
}
