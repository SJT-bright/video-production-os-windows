'use strict';

(() => {
  const api = window.creatorAPI;
  const openButton = document.getElementById('creatorWorkflowOpen');
  if (!api?.automation) { if (openButton) openButton.hidden = true; return; }
  const labels = { prompt: '读取提示词', assets: '补齐资产', references: '绑定参考图', submit: '准备提交', generating: '等待生成', archive: '验收归档', complete: '已完成' };
  const dialog = document.createElement('dialog');
  dialog.className = 'automation-dialog';
  dialog.setAttribute('aria-label', '制作流程');
  document.body.appendChild(dialog);
  const style = document.createElement('style');
  style.textContent = `.automation-dialog{width:min(820px,90vw);max-height:85vh;border:1px solid #dce2eb;border-radius:16px;padding:24px;color:#223044;background:#fff;box-shadow:0 20px 80px #17294433}.automation-dialog::backdrop{background:#12203866}.automation-dialog header{display:flex;justify-content:space-between;gap:16px;align-items:center}.automation-dialog h2{margin:0 0 14px}.automation-dialog label{display:grid;gap:6px;margin:12px 0}.automation-dialog select,.automation-dialog input,.automation-dialog textarea{box-sizing:border-box;width:100%;padding:9px;border:1px solid #ccd5e2;border-radius:8px;background:#fff;color:#223044}.automation-dialog button{padding:8px 14px;border:1px solid #ccd5e2;border-radius:8px;cursor:pointer;background:#eef3ff;color:#25426e;margin:4px}.automation-dialog button:disabled{opacity:.5;cursor:wait}.automation-dialog p{line-height:1.6;overflow-wrap:anywhere}.automation-dialog article{border-top:1px solid #e1e6ee;padding:14px 0}.automation-dialog pre{white-space:pre-wrap;max-height:250px;overflow:auto;background:#f5f7fa;padding:12px;border-radius:8px}.automation-dialog .automation-error{color:#b33535;white-space:pre-wrap}.automation-dialog small{color:#63758c}.asset-send-button{position:absolute;bottom:4px;left:4px;z-index:3;background:#ecf3ff;color:#2359a6;border:1px solid #c8d9f1;border-radius:6px;font-size:11px;padding:3px 6px;cursor:pointer}`;
  document.head.appendChild(style);
  const call = (name, args = {}) => api.automation(name, args);
  const elem = (tag, text, parent = dialog) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; parent.appendChild(e); return e; };
  function button(text, action, parent = dialog) {
    const b = elem('button', text, parent); b.type = 'button';
    b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { error(e.message); } finally { b.disabled = false; } };
    return b;
  }
  function error(message) { let e = dialog.querySelector('.automation-error'); if (!e) e = elem('p'); e.className = 'automation-error'; e.textContent = message; }
  function show(title) {
    dialog.replaceChildren(); const header = elem('header'); elem('h2', title, header); button('关闭', () => dialog.close(), header);
    if (!dialog.open) { dialog.showModal(); api.setPlatformViewHidden(true).catch(() => {}); }
  }
  dialog.addEventListener('close', () => api.setPlatformViewHidden(!!document.querySelector('dialog[open]')).catch(() => {}));
  async function sendAsset(assetPath) {
    show('传入网页');
    try {
      const state = await call('browser_state');
      if (!state.project || !state.tabId || !state.url) throw new Error('请先选择项目，并打开目标网页的上传区域');
      const bind = { projectId: state.project.id, tabId: state.tabId, expectedUrl: state.url };
      const snap = await call('page_read', bind);
      const inputs = snap.controls.filter(c => c.tag === 'input' && c.type === 'file' && !c.disabled && !c.files?.length);
      elem('p', `${assetPath.split('/').at(-1)} → ${snap.title}`);
      elem('small', snap.url);
      if (!inputs.length) throw new Error('当前页面没有空的上传框。请关闭此面板，在核绘打开“上传场景”或对应参考图的上传区域，再点“传网页”。');
      let chosen = inputs[0].ref;
      if (inputs.length > 1) {
        const label = elem('label', '当前页面有多个上传位置，请选择');
        const select = elem('select', undefined, label);
        inputs.forEach((input, index) => { const option = elem('option', `${index + 1}. ${input.label || '上传框'} ${input.accept || ''}`, select); option.value = input.ref; });
        select.onchange = () => { chosen = select.value; };
      }
      const upload = async () => {
        const result = await call('asset_upload', { ...bind, snapshotId: snap.snapshotId, ref: chosen, operationId: crypto.randomUUID(), paths: [assetPath] });
        show('图片已传入网页');
        elem('p', result.next);
        button('返回网页查看结果', () => dialog.close());
      };
      if (inputs.length === 1) await upload();
      else button('传入选中的上传框', upload);
    } catch (e) { error(e.message); }
  }
  async function sendDownload(download) {
    show('定位归档文件');
    try {
      const state = await call('browser_state');
      if (download.projectId && download.projectId !== state.project?.id) throw new Error('下载文件属于另一个项目');
      const assets = await call('asset_list', { projectId: state.project.id, search: download.filename || '' });
      const matches = assets.items.filter(a => download.savePath.replace(/\\/g, '/').endsWith('/' + a.path));
      if (matches.length !== 1) throw new Error('归档文件尚未唯一定位，请从左侧资产库选择该图片');
      await sendAsset(matches[0].path);
    } catch (e) { error(e.message); }
  }
  async function showWorkflows() {
    show('制作流程');
    try {
      const state = await call('browser_state');
      if (!state.project) throw new Error('请先选择项目');
      const projectId = state.project.id;
      elem('p', `${state.project.name} · 本地自动化接口已就绪`);
      elem('small', 'AI 可以读取指定 GPT 对话、传递资产并记录制作进度。中断后从已保存的步骤继续；不会因打开面板自动提交生成。');
      const form = elem('details'); elem('summary', '新建镜头流程', form);
      const titleLabel = elem('label', '镜头名称', form); const title = elem('input', undefined, titleLabel); title.placeholder = '例如：第十集 10-1 第3段';
      const selects = {};
      for (const [role, caption] of [['prompt', '提示词对话'], ['image', '资产生图对话'], ['video', '视频生成网页']]) {
        const label = elem('label', caption, form); const select = elem('select', undefined, label); selects[role] = select;
        for (const tab of state.tabs) { const option = elem('option', `${tab.label} · ${tab.url}`, select); option.value = tab.id; }
        if (role === 'image' && select.options.length > 1) select.selectedIndex = 1;
        if (role === 'video' && state.tabId) select.value = state.tabId;
      }
      button('保存并开始记录', async () => {
        await call('workflow_create', { projectId, title: title.value, promptTabId: selects.prompt.value, imageTabId: selects.image.value, videoTabId: selects.video.value });
        await showWorkflows();
      }, form);
      const listing = await call('workflow_list', { projectId });
      const uncertain = listing.operations.filter(o => ['running', 'uncertain'].includes(o.status));
      if (uncertain.length) elem('p', `有 ${uncertain.length} 次操作需要核实网页结果；已阻止使用原编号重复提交。`);
      if (!listing.runs.length) elem('p', '还没有镜头流程。新建后会保存提示词、资产用途、平台绑定及生成回执。');
      for (const run of listing.runs) {
        const card = elem('article'); elem('strong', `${run.title} · ${labels[run.stage]}`, card);
        elem('p', `参考图 ${run.assets.filter(a => a.status === 'bound').length}/${run.assets.length} 已绑定 · ${run.status === 'blocked' ? '等待处理' : run.status === 'done' ? '完成' : '可接续'}`, card);
        button('查看与接续', () => showRun(projectId, run.id), card);
      }
      button('刷新进度', showWorkflows);
    } catch (e) { error(e.message); }
  }
  async function showRun(projectId, id) {
    const run = await call('workflow_get', { projectId, id });
    show(run.title);
    elem('p', Object.entries(labels).map(([key, label]) => key === run.stage ? `【${label}】` : label).join(' → '));
    for (const [role, label] of [['prompt', '提示词'], ['image', '生图'], ['video', '视频']]) {
      const binding = run.bindings[role];
      elem('p', `${label}：${binding.title || binding.url}`);
      button(`打开${label}页面`, async () => { await api.selectTab(binding.tabId); dialog.close(); });
    }
    if (run.prompt) { elem('h3', '已保存提示词'); elem('pre', run.prompt); }
    const tail = { unknown: '待判断', none: '不需要', reference: '作为连续性参考', first_frame: '作为强制首帧' };
    elem('p', `尾帧：${tail[run.tailMode]}；新场景：${run.newScene === null ? '待判断' : run.newScene ? '有' : '无'}`);
    for (const asset of run.assets) elem('p', `${asset.key} · ${asset.purpose} · ${asset.status === 'bound' ? '已绑定' : asset.status === 'ready' ? '已备齐' : asset.status === 'unverified' ? '待核对' : '缺失'}${asset.binding ? ' · ' + asset.binding : ''}`);
    for (const receipt of run.receipts) elem('p', `${receipt.kind}：${receipt.evidence}`);
    const label = elem('label', '接续备注'); const notes = elem('textarea', undefined, label); notes.value = run.notes; notes.rows = 3;
    button('保存备注', async () => { await call('workflow_update', { projectId, id, revision: run.revision, patch: { notes: notes.value } }); await showRun(projectId, id); });
    button('返回流程列表', showWorkflows);
  }
  window.creatorAutomationUI = Object.freeze({ sendAsset, sendDownload, showWorkflows });
  openButton?.addEventListener('click', showWorkflows);
})();
