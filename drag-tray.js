'use strict';

// 剪映拖拽助手：置顶小窗列出当前剧本资产，卡片原生拖拽进剪映，点卡片复制文件到剪贴板（剪映 ⌘V）。
const el = Object.fromEntries([
  'trayProject', 'trayRefresh', 'trayClose', 'trayChips', 'trayList', 'trayToast',
  'traySelectMode', 'trayBatch', 'trayCopyBatch', 'trayClearSelection',
].map(id => [id, document.getElementById(id)]));

const state = { filter: 'all', assets: [] };
// 选择模式：点卡片按点击顺序选入序列，「复制到剪映」按该顺序放入剪贴板文件列表——
// 剪映一次 ⌘V 按同一顺序导入，正好对应「哪一集第几个片段」的依次导入需求。
let selectMode = false;
const selectionOrder = [];

let toastTimer = null;
function showToast(message) {
  el.trayToast.textContent = message;
  el.trayToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.trayToast.classList.remove('show'), 2200);
}

function assetUrl(relativePath) {
  return `/api/creative-assets/file?project=${encodeURIComponent(activeProjectId())}&p=${encodeURIComponent(relativePath)}`;
}

function activeProjectId() {
  return window.__trayProjectId || 'inspiration';
}

function flattenAssets(node, out) {
  if (!node) return;
  if (node.kind === 'folder') {
    (node.children || []).forEach(child => flattenAssets(child, out));
    return;
  }
  if (['image', 'video', 'audio'].includes(node.type)) out.push(node);
}

// 请求代号守卫：快速切换项目/连续刷新时，后完成的旧响应不得覆盖新渲染；
// 旧错误（读取失败）同样不得覆盖新成功提示。每次关键 await 后都核对代号。
let libraryRequestId = 0;

async function loadAssets() {
  const requestId = ++libraryRequestId;
  el.trayList.replaceChildren(Object.assign(document.createElement('div'), { className: 'tray-state', textContent: '正在读取资产…' }));
  try {
    // 先取 active 项目确定身份，再带明确 project 参数请求资产（API 按 project 返回对应剧本树）
    const projectsResp = await fetch('/api/creative-projects', { cache: 'no-store' });
    const projects = await projectsResp.json();
    if (requestId !== libraryRequestId) return;
    const project = (projects.projects || []).find(item => item.id === projects.activeProjectId) || null;
    const newProjectId = projects.activeProjectId || 'inspiration';
    const projectChanged = window.__trayProjectId !== newProjectId;
    // 项目切换或资产被删除后，清掉不再存在的选入项，避免整批拖出失败
    if (projectChanged) selectionOrder.length = 0;
    window.__trayProjectId = newProjectId;
    el.trayProject.textContent = project ? project.name : '灵感生成';
    const assetsResp = await fetch(`/api/creative-assets?project=${encodeURIComponent(newProjectId)}`, { cache: 'no-store' });
    const assets = await assetsResp.json();
    if (requestId !== libraryRequestId || activeProjectId() !== newProjectId) return;
    const files = [];
    flattenAssets(assets.tree, files);
    state.assets = files;
    const existing = new Set(files.map(item => item.path));
    const before = selectionOrder.length;
    if (before) {
      for (let i = selectionOrder.length - 1; i >= 0; i--) {
        if (!existing.has(selectionOrder[i])) selectionOrder.splice(i, 1);
      }
      if (selectionOrder.length !== before) showToast(`已自动移除 ${before - selectionOrder.length} 个失效选项`);
    }
    if (requestId !== libraryRequestId) return;
    renderLog.push(`render req=${requestId} project=${newProjectId}`);
    renderList();
  } catch (error) {
    // 旧请求的读取失败不得覆盖新项目的成功渲染
    if (requestId !== libraryRequestId) return;
    el.trayList.replaceChildren(Object.assign(document.createElement('div'), { className: 'tray-state', textContent: `读取失败：${error.message}` }));
  }
}

function updateBatchBar() {
  el.trayBatch.hidden = !(selectMode && selectionOrder.length);
  el.trayBatchHint.textContent = selectionOrder.length
    ? `已选 ${selectionOrder.length} 项 · 拖动任一选中卡整批拖进剪映`
    : '拖动任一选中卡，整批拖进剪映';
}

const renderLog = [];
function renderList() {
  const files = state.assets.filter(item => state.filter === 'all' || item.type === state.filter);
  renderLog.push(`selectMode=${selectMode} sel=${selectionOrder.length} files=${files.length}`);
  if (renderLog.length > 6) renderLog.shift();
  el.trayList.replaceChildren();
  if (!files.length) {
    el.trayList.appendChild(Object.assign(document.createElement('div'), { className: 'tray-state', textContent: '该类型暂无资产' }));
    return;
  }
  const KIND_TEXT = { image: '图片', video: '视频', audio: '音频' };
  for (const item of files.slice(0, 120)) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tray-card';
    card.dataset.path = item.path;
    const orderIndex = selectionOrder.indexOf(item.path);
    if (selectMode && orderIndex !== -1) {
      card.classList.add('selected');
      card.dataset.order = String(orderIndex + 1);
    }
    card.title = selectMode
      ? `点按选入导入序列（当前第 ${orderIndex === -1 ? selectionOrder.length + 1 : orderIndex + 1} 个）`
      : `${item.name}\n拖到剪映导入；点按复制文件`;
    card.setAttribute('draggable', String(!selectMode));
    const thumb = document.createElement('span');
    thumb.className = 'tray-thumb';
    if (item.type === 'image') {
      const image = document.createElement('img');
      image.src = assetUrl(item.path);
      image.alt = '';
      image.loading = 'lazy';
      image.draggable = false;
      thumb.appendChild(image);
    } else {
      thumb.textContent = item.type === 'video' ? '▶' : '♪';
    }
    const name = document.createElement('span');
    name.className = 'tray-name';
    name.textContent = item.name;
    const kind = document.createElement('span');
    kind.className = 'tray-kind';
    kind.textContent = KIND_TEXT[item.type] || item.type;
    const main = document.createElement('span');
    main.className = 'tray-main';
    main.style.cssText = 'display:grid;gap:2px;min-width:0;';
    main.append(name, kind);
    card.append(thumb, main);
    let dragged = false;
    card.addEventListener('pointerdown', () => { dragged = false; });
    card.addEventListener('dragstart', event => {
      dragged = true;
      if (window.trayAPI && typeof window.trayAPI.startDrag === 'function') {
        event.preventDefault();
        // 选择模式下拖任意选中卡片 = 整个选中序列按选入顺序一起拖出（原生多文件拖动）
        if (selectMode && selectionOrder.length) {
          window.trayAPI.startDragSelection([...selectionOrder]);
          return;
        }
        window.trayAPI.startDrag(item.path);
      } else if (event.dataTransfer) {
        event.dataTransfer.setData('text/plain', item.name);
        event.dataTransfer.effectAllowed = 'copy';
      }
    });
    card.addEventListener('dragend', () => { dragged = false; });
    card.addEventListener('click', () => {
      if (dragged) return;
      if (selectMode) {
        const idx = selectionOrder.indexOf(item.path);
        if (idx === -1) selectionOrder.push(item.path);
        else selectionOrder.splice(idx, 1);
        updateBatchBar();
        renderList();
      }
    });
    el.trayList.appendChild(card);
  }
}

el.trayChips.addEventListener('click', event => {
  const button = event.target.closest('.chip');
  if (!button) return;
  state.filter = button.dataset.filter;
  el.trayChips.querySelectorAll('.chip').forEach(chip => chip.classList.toggle('on', chip === button));
  renderList();
});

el.trayRefresh.addEventListener('click', () => loadAssets().catch(() => {}));
el.trayClose.addEventListener('click', () => { if (window.trayAPI) window.trayAPI.closeTray(); });
el.traySelectMode.addEventListener('click', () => {
  selectMode = !selectMode;
  el.traySelectMode.classList.toggle('on', selectMode);
  if (!selectMode) selectionOrder.length = 0;
  updateBatchBar();
  renderList();
});
el.trayClearSelection.addEventListener('click', () => {
  selectionOrder.length = 0;
  updateBatchBar();
  renderList();
});

if (window.trayAPI && typeof window.trayAPI.onDragResult === 'function') {
  window.trayAPI.onDragResult(result => {
    if (result && result.ok) showToast('已开始拖拽，松手放入剪映');
    else if (result) showToast(result.error || '拖拽未完成');
  });
}

const events = new EventSource('/api/events');
events.addEventListener('creative-assets', () => { loadAssets().catch(() => {}); });
events.addEventListener('creative-projects', () => { loadAssets().catch(() => {}); });

// 只读观测口（测试/诊断用）
window.__trayDebug = () => ({ selectMode, selection: [...selectionOrder], assets: state.assets.length, renderLog: [...renderLog] });

loadAssets();
