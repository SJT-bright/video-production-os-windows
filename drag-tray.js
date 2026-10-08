'use strict';

// 剪映拖拽助手：置顶小窗列出当前剧本的视频和音频，卡片原生拖拽进剪映；导入剪映只走拖拽。
const el = Object.fromEntries([
  'trayProject', 'trayRefresh', 'trayClose', 'trayChips', 'trayList', 'trayToast', 'trayStatus',
  'traySelectMode', 'trayBatch', 'trayBatchHint', 'trayClearSelection',
].map(id => [id, document.getElementById(id)]));

const state = { filter: 'video', assets: [] };
// 多选模式：点卡片按点击顺序选入序列，拖动任一选中卡把整批按同一顺序拖进剪映——
// 剪映素材库按该顺序接收，正好对应「哪一集第几个片段」的依次导入需求。
let selectMode = false;
const selectionOrder = [];

let toastTimer = null;
function showToast(message) {
  el.trayToast.textContent = message;
  el.trayToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.trayToast.classList.remove('show'), 2200);
}

function activeProjectId() {
  return window.__trayProjectId || 'inspiration';
}

// 剪映联动只需要视频和音频；成片不进悬浮窗（成片走成片库管理，避免误拖进剪辑）。
// 成片语义核对（已完成核对，仅落注释、不改行为）：
// ① editorExports.owner（editor-exports.cjs:65-67）把 finals 定义为「项目成片分类文件夹（<项目>/成片/）下的视频」；
// ② purpose=finals 只作用于外部媒体索引来源（server.js:1464），悬浮窗数据源是创作资产树，不经过该来源；
// ③ 因此在本数据源上按文件夹名跳过「成片」与 finals 过滤语义等价；显示层排除只影响列表，永不删除文件。
function flattenAssets(node, out) {
  if (!node) return;
  if (node.kind === 'folder') {
    if (node.name === '成片') return;
    (node.children || []).forEach(child => flattenAssets(child, out));
    return;
  }
  if (['video', 'audio'].includes(node.type)) out.push(node);
}

// 角标索引：与“全部资产”的索引方式一致——文件名尾号（尾号前必须有 -、_ 或空格分隔符：
// 生成视频-029 → #029、IMG_1234 → #1234；final_v2 这类版本尾号不算索引）加生成日期。
// 日期只扫描目录部分（路径去掉文件名），避免文件名里的日期覆盖日期文件夹语义；
// 目录无日期时回退文件修改时间，并按本地时区取年月日——直接切 UTC ISO 串会让
// UTC+8 凌晨生成的文件显示成前一天。
function assetBadge(item) {
  const stem = item.name.replace(/\.[^.]+$/, '');
  const seq = (stem.match(/[-_\s](\d{1,4})$/) || [])[1] || '';
  const dirPart = String(item.path || '').replace(/[^/]+$/, '');
  const dateMatches = [...dirPart.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  let year, month, day;
  if (dateMatches.length) {
    [, year, month, day] = dateMatches[dateMatches.length - 1];
  } else if (item.mtime) {
    const local = new Date(item.mtime);
    if (!Number.isNaN(local.getTime())) {
      year = String(local.getFullYear());
      month = String(local.getMonth() + 1).padStart(2, '0');
      day = String(local.getDate()).padStart(2, '0');
    }
  }
  const shortDate = month ? `${Number(month)}/${Number(day)}` : '';
  const fullDate = year ? `${year}-${month}-${day}` : '';
  return {
    date: fullDate,
    text: [seq && `#${seq}`, shortDate].filter(Boolean).join(' '),
    title: fullDate
      ? (seq ? `全部资产索引：${stem} · 生成日期 ${fullDate}` : `生成日期 ${fullDate}`)
      : (seq ? `全部资产索引：${stem}` : ''),
  };
}

function newestFirst(a, b) {
  return assetBadge(b).date.localeCompare(assetBadge(a).date)
    || ((Date.parse(b.mtime) || 0) - (Date.parse(a.mtime) || 0))
    || b.name.localeCompare(a.name, 'zh-CN', { numeric: true });
}

let coverObserver = null;
function releaseCovers() {
  if (coverObserver) coverObserver.disconnect();
  el.trayList.querySelectorAll('video').forEach(video => {
    video.removeAttribute('src');
    video.load();
  });
}

// 请求代号守卫：快速切换项目/连续刷新时，后完成的旧响应不得覆盖新渲染；
// 旧错误（读取失败）同样不得覆盖新成功提示。每次关键 await 后都核对代号。
let libraryRequestId = 0;

async function loadAssets() {
  const requestId = ++libraryRequestId;
  releaseCovers();
  el.trayList.replaceChildren(Object.assign(document.createElement('div'), { className: 'tray-state', textContent: '正在读取资产…' }));
  try {
    // 先取 active 项目确定身份，再带明确 project 参数请求资产（API 按 project 返回对应剧本树）
    const projectsResp = await fetch('/api/creative-projects', { cache: 'no-store' });
    const projects = await projectsResp.json();
    if (requestId !== libraryRequestId) return;
    const project = (projects.projects || []).find(item => item.id === projects.activeProjectId) || null;
    const newProjectId = projects.activeProjectId || 'inspiration';
    // 项目切换或资产被删除后，清掉不再存在的选入项，避免整批拖出失败；切换清空要给出提示。
    // 注意：projectChanged 只允许在“上一轮已完成渲染的项目”与本次不同时为真；
    // 首次加载没有旧项目，不算切换。
    const projectChanged = window.__trayProjectId != null && window.__trayProjectId !== newProjectId;
    if (projectChanged && selectionOrder.length) {
      showToast(`已切换到「${project ? project.name : '灵感生成'}」，原选中 ${selectionOrder.length} 项已清空`);
      selectionOrder.length = 0;
    } else if (projectChanged) {
      selectionOrder.length = 0;
    }
    window.__trayProjectId = newProjectId;
    el.trayProject.textContent = project ? project.name : '灵感生成';
    const assetsResp = await fetch(`/api/creative-assets?project=${encodeURIComponent(newProjectId)}`, { cache: 'no-store' });
    const assets = await assetsResp.json();
    // 只用请求代号防串台：项目切换一定会触发新的 loadAssets（SSE creative-projects），
    // 旧响应由代号守卫丢弃。这里绝不能再对比旧项目 ID，否则项目一切换本次渲染必然自弃，
    // 悬浮窗将永久卡在旧项目列表上，后续每次拖拽都被主进程以「资产不属于当前剧本」拒绝。
    if (requestId !== libraryRequestId) return;
    const files = [];
    flattenAssets(assets.tree, files);
    state.assets = files.sort(newestFirst);
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
// 板块计数与常显状态行：供人工和自动化操作快速核对当前列表内容
function updateChipsAndStatus() {
  const counts = { video: 0, audio: 0 };
  for (const item of state.assets) {
    if (counts[item.type] !== undefined) counts[item.type]++;
  }
  el.trayChips.querySelectorAll('.chip').forEach(chip => {
    const type = chip.dataset.filter;
    const label = type === 'video' ? '视频' : '音频';
    chip.textContent = `${label} ${counts[type] || 0}`;
  });
  const activeLabel = state.filter === 'video' ? '视频' : '音频';
  // 列表最多渲染 120 张卡（renderList 的 slice(0,120)），状态行计的却是全部资产：
  // 当前板块过滤后超出 120 时在状态行追加说明，避免大库下「可见卡数 ≠ 计数」造成误读。
  const visibleInTab = state.assets.filter(item => item.type === state.filter).length;
  const capNote = visibleInTab > 120 ? ' · 已显示前 120 项' : '';
  el.trayStatus.textContent =
    `共 ${state.assets.length} 项 · 视频 ${counts.video || 0} · 音频 ${counts.audio || 0} ｜ 当前板块：${activeLabel}${capNote}`;
}

function renderList() {
  // 动效层：首次列表渲染保留一次性入场标记（前 12 张卡片交错淡入），900ms 后摘除，
  // 之后的刷新/过滤重渲染不再闪动；纯观感，不参与任何渲染数据与测试断言。
  if (document.body.classList.contains('motion-in')) {
    setTimeout(() => document.body.classList.remove('motion-in'), 900);
  }
  updateChipsAndStatus();
  const files = state.assets.filter(item => item.type === state.filter);
  renderLog.push(`selectMode=${selectMode} sel=${selectionOrder.length} files=${files.length}`);
  if (renderLog.length > 6) renderLog.shift();
  releaseCovers();
  el.trayList.replaceChildren();
  coverObserver = new IntersectionObserver(entries => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      target.src = target.dataset.src;
      coverObserver.unobserve(target);
    });
  }, { root: el.trayList, rootMargin: '120px' });
  if (!files.length) {
    el.trayList.appendChild(Object.assign(document.createElement('div'), { className: 'tray-state', textContent: '该类型暂无资产' }));
    return;
  }
  const KIND_TEXT = { video: '视频', audio: '音频' };
  for (const item of files.slice(0, 120)) {
    const badge = assetBadge(item);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'tray-card';
    card.dataset.path = item.path;
    const orderIndex = selectionOrder.indexOf(item.path);
    if (selectMode && orderIndex !== -1) {
      card.classList.add('selected');
      card.dataset.order = String(orderIndex + 1);
    }
    // 选择模式下点按与拖拽并存：tooltip 同步说明两种操作，避免「选择模式只能点按」的误导
    let actionTitle;
    if (!selectMode) {
      actionTitle = `${item.name}，拖到剪映导入`;
    } else if (orderIndex === -1) {
      actionTitle = `点按选入导入序列（当前第 ${selectionOrder.length + 1} 个）`
        + (selectionOrder.length ? '；拖动选中卡整批拖进剪映' : '');
    } else {
      actionTitle = `已选入序列（第 ${orderIndex + 1} 个）· 点按取消；拖动任一选中卡整批拖进剪映`;
    }
    card.title = [actionTitle, badge.title].filter(Boolean).join('\n');
    card.setAttribute('aria-label', [
      `${KIND_TEXT[item.type] || item.type} ${item.name}`,
      badge.text ? `索引 ${badge.text}` : '',
      selectMode ? '点按选入' : '拖到剪映',
    ].filter(Boolean).join('，'));
    // 卡片始终可拖拽：选择模式下真实鼠标拖拽同样要触发 dragstart（拖任一选中卡 = 整批拖出）。
    // 若随 selectMode 关闭 draggable，按 HTML 规范不会发起拖拽，整批拖出将不可达。
    card.setAttribute('draggable', 'true');
    const thumb = document.createElement('span');
    thumb.className = 'tray-thumb';
    thumb.textContent = item.type === 'video' ? '▶' : '♪';
    if (item.type === 'video') {
      const cover = document.createElement('video');
      cover.className = 'tray-cover';
      cover.muted = true;
      cover.defaultMuted = true;
      cover.playsInline = true;
      cover.preload = 'auto';
      cover.draggable = false;
      cover.tabIndex = -1;
      cover.setAttribute('aria-hidden', 'true');
      cover.dataset.src = `/api/creative-assets/file?project=${encodeURIComponent(activeProjectId())}&p=${encodeURIComponent(item.path)}#t=0.001`;
      cover.addEventListener('loadeddata', () => cover.classList.add('ready'), { once: true });
      cover.addEventListener('error', () => cover.classList.remove('ready'));
      thumb.appendChild(cover);
      coverObserver.observe(cover);
    }
    if (badge.text) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'tray-badge';
      badgeEl.textContent = badge.text;
      thumb.appendChild(badgeEl);
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
        // 选择模式下拖「选中卡」= 整个选中序列按选入顺序一起拖出（原生多文件拖动）；
        // 拖未选中的卡则只拖该卡本身——与文案「拖动任一选中卡」保持一致，避免误发整批。
        if (selectMode && selectionOrder.length && selectionOrder.includes(item.path)) {
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
        if (idx === -1) {
          // 与主进程上限对齐：一次最多整批拖出 100 个文件，超限直接提示
          if (selectionOrder.length >= 100) { showToast('一次最多整批拖出 100 项'); return; }
          selectionOrder.push(item.path);
        } else {
          selectionOrder.splice(idx, 1);
        }
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
  // 换页动效只在筛选值真正变化的那一次渲染后播：以赋值前的旧值对比判定，前后相等不播。
  // 点已激活 chip、同 filter 的数据刷新、项目切换、多选开关都不经过这里，避免每次刷新都闪。
  const filterChanged = state.filter !== button.dataset.filter;
  state.filter = button.dataset.filter;
  el.trayChips.querySelectorAll('.chip').forEach(chip => chip.classList.toggle('on', chip === button));
  renderList();
  if (filterChanged) playListSwap();
});

el.trayRefresh.addEventListener('click', () => loadAssets().catch(() => {}));
el.trayClose.addEventListener('click', () => { if (window.trayAPI) window.trayAPI.closeTray(); });
el.traySelectMode.addEventListener('click', () => {
  selectMode = !selectMode;
  el.traySelectMode.classList.toggle('on', selectMode);
  el.traySelectMode.setAttribute('aria-pressed', String(selectMode));
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
    else if (result) {
      showToast(result.error || '拖拽未完成');
      // 主进程认的当前项目与悬浮窗列表不一致（列表可能已过期）时，立即重载对齐，下一拖即可用
      if (typeof result.error === 'string' && result.error.includes('不属于当前剧本')) loadAssets().catch(() => {});
    }
  });
}

// 窗口拖拽兜底：标题栏原生 -webkit-app-region 失效的机器上，用指针位移让主进程移动窗口。
// 原生拖拽区生效时指针事件不会到达页面，两条路径不会叠加。
const trayHead = document.querySelector('.tray-head');
let windowDrag = null;
trayHead.addEventListener('pointerdown', event => {
  if (event.target.closest('.tray-btn')) return;
  if (!window.trayAPI || typeof window.trayAPI.moveWindow !== 'function') return;
  if (typeof event.screenX !== 'number') return;
  windowDrag = { x: event.screenX, y: event.screenY };
  try { trayHead.setPointerCapture(event.pointerId); } catch {}
});
trayHead.addEventListener('pointermove', event => {
  if (!windowDrag) return;
  const dx = Math.round(event.screenX - windowDrag.x);
  const dy = Math.round(event.screenY - windowDrag.y);
  windowDrag.x = event.screenX;
  windowDrag.y = event.screenY;
  if (dx || dy) window.trayAPI.moveWindow(dx, dy);
});
const endWindowDrag = () => { windowDrag = null; };
trayHead.addEventListener('pointerup', endWindowDrag);
trayHead.addEventListener('pointercancel', endWindowDrag);

const events = new EventSource('/api/events');
events.addEventListener('creative-assets', () => { loadAssets().catch(() => {}); });
events.addEventListener('creative-projects', () => { loadAssets().catch(() => {}); });

// 只读观测口（测试/诊断用）
window.__trayDebug = () => ({ selectMode, selection: [...selectionOrder], assets: state.assets.length, renderLog: [...renderLog] });

// —— 动效层（仅观感，契约与主窗口一致）——
// 入场标记：自动化环境（navigator.webdriver）不注入，测试页面完全静态；
// 真实窗口加载后播整体入场 + 首次列表交错淡入，标记由 renderList 延时摘除。
if (!navigator.webdriver) document.body.classList.add('motion-in');
// 开关回弹：chip 切换、多选开关（aria-pressed）点击时播一次 motion-tick，
// 动画结束由 playMotionClass 自摘（与 creator.js 同一套实现，400ms 兜底）。
function playMotionClass(node, cls, fallbackMs, animationNames) {
  if (!node) return;
  let timer = 0;
  const finish = () => {
    node.removeEventListener('animationend', onAnimationEnd);
    if (timer) { clearTimeout(timer); timer = 0; }
    node.classList.remove(cls);
  };
  function onAnimationEnd(event) {
    if (event.target !== node || !animationNames.includes(event.animationName)) return;
    finish();
  }
  node.classList.add(cls);
  node.addEventListener('animationend', onAnimationEnd);
  timer = setTimeout(finish, fallbackMs);
}
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const toggle = event.target.closest('.chip, button[aria-pressed]');
  if (toggle && !toggle.disabled) playMotionClass(toggle, 'motion-tick', 400, ['motionTick']);
});

// 筛选换页：筛选值真正变化的渲染完成后给列表容器挂 motion-swap，前 8 张卡交错淡入；
// 空列表等收不到 animationend 的情况由 320ms 兜底自摘。
let stopListSwap = null;
function playListSwap() {
  const list = el.trayList;
  if (!list) return;
  // 320ms 内连点 chip 时先终止上一轮（监听/计时器），再摘类并强制 reflow，动画才能重启而不是被同类名吞掉
  if (stopListSwap) stopListSwap();
  let timer = 0;
  let endedCount = 0;
  function finish() {
    list.removeEventListener('animationend', onAnimationEnd);
    if (timer) { clearTimeout(timer); timer = 0; }
    list.classList.remove('motion-swap');
    stopListSwap = null;
  }
  function onAnimationEnd(event) {
    if (event.animationName !== 'motionSwapIn') return;
    // 交错淡入按张次先后结束：等最后一张（≤8 张）收尾再摘类，早摘会砍掉后面几张的动画
    endedCount += 1;
    if (endedCount < Math.min(list.querySelectorAll('.tray-card').length, 8)) return;
    finish();
  }
  list.classList.remove('motion-swap');
  void list.offsetWidth;
  list.classList.add('motion-swap');
  list.addEventListener('animationend', onAnimationEnd);
  timer = setTimeout(finish, 320);
}

loadAssets();
