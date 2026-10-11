'use strict';

// 单视频置顶浮窗渲染层。
// 边界：只经 electron/float-video-preload.cjs 暴露的安全 API 读取「当前置顶视频」信息，
// 再把这一个视频原生拖出到剪映——与剪映联动窗同一条主进程 webContents.startDrag 路线。
// 渲染层没有 fs、没有绝对路径、不能提交任意素材路径；主进程每次都按当前剧本重新校验，
// 剧本切换后旧视频既读不到也拖不出，并会直接关掉本窗、通知左栏还原卡片。
// 文件拖出成功开始后由主进程自动收起；未拖出时仍可用右上角 × 关闭。
// 不绑定 Esc、不做双击关闭，也不会删除或移动任何素材文件。

const el = Object.fromEntries([
  'fvProject', 'fvClose', 'fvCard', 'fvPreview', 'fvStageState', 'fvName', 'fvKind', 'fvGrip', 'fvToast',
].map(id => [id, document.getElementById(id)]));

let info = null;            // {path, name, fileUrl, projectId, projectName, size}
let loading = null;         // 进行中的读取，避免 focus/visibility 并发重复请求
let toastTimer = null;
const shell = document.getElementById('fvShell');
let presentation = null, presentationAnimation = null;

function resetPresentation() {
  presentationAnimation?.cancel(); presentationAnimation = null; presentation = null;
  shell.classList.remove('is-presenting'); shell.removeAttribute('style');
  document.body.dataset.presenting = 'false';
}

function finishPresentation() {
  const id = presentation?.id;
  if (!id) return;
  // 指针按下可立即中断动效；关闭和拖出不必等待动画播完。
  presentationAnimation?.cancel(); presentationAnimation = null;
  shell.style.transform = 'none'; shell.style.opacity = '1';
  document.body.dataset.presenting = 'false';
  window.floatVideoAPI?.settlePresentation?.(id);
}

function preparePresentation(next) {
  if (!next?.id || presentation?.id === next.id) return;
  resetPresentation(); presentation = next;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = reduced ? 'none' : `translate(${next.dx}px, ${next.dy}px) scale(${next.scaleX}, ${next.scaleY})`;
  Object.assign(shell.style, { inset: 'auto', left: `${next.left}px`, top: `${next.top}px`, width: `${next.width}px`, height: `${next.height}px`, transform: from, opacity: reduced ? '0' : '.7' });
  shell.classList.add('is-presenting'); document.body.dataset.presenting = 'prepared';
  requestAnimationFrame(() => requestAnimationFrame(() => { if (presentation?.id === next.id) window.floatVideoAPI?.readyToPresent?.(next.id); }));
}

window.floatVideoAPI?.onPrepare?.(preparePresentation);
window.floatVideoAPI?.onPresent?.(({ id }) => {
  if (!presentation || presentation.id !== id) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.dataset.presenting = 'true';
  presentationAnimation = shell.animate([
    { transform: shell.style.transform, opacity: reduced ? 0 : .7 },
    { transform: 'none', opacity: 1 },
  ], { duration: reduced ? 120 : 300, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' });
  presentationAnimation.finished.then(() => { if (presentation?.id === id) finishPresentation(); }).catch(() => {});
});
window.floatVideoAPI?.onSettled?.(({ id }) => { if (!presentation || presentation.id === id) resetPresentation(); });
shell.addEventListener('pointerdown', finishPresentation, true);

function showToast(message) {
  el.fvToast.textContent = message;
  el.fvToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.fvToast.classList.remove('show'), 2200);
}

function setStageState(text, tone) {
  el.fvStageState.hidden = !text;
  el.fvStageState.textContent = text || '';
  el.fvStageState.className = `fv-stage-state${tone ? ` ${tone}` : ''}`;
}

// ipcRenderer.invoke 的 rejection 前缀是给开发者看的，浮窗里只留业务提示语。
function readableError(error, fallback) {
  const raw = String((error && error.message) || error || fallback || '当前视频不可用');
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function render(next) {
  info = next;
  document.body.dataset.ready = 'true';
  document.body.dataset.floatPath = next.path;
  document.body.dataset.projectId = next.projectId || '';
  el.fvProject.textContent = next.projectName || '灵感生成';
  el.fvName.textContent = next.name;
  el.fvName.title = next.name;
  const processing = next.disposition === 'processing';
  el.fvKind.textContent = processing ? '待处理 · 拖到 Updream 处理' : '可剪辑 · 拖到剪映松手导入';
  el.fvGrip.textContent = processing ? '按住此卡拖动，松手放入 Updream' : '按住此卡拖动，松手放入剪映';
  el.fvCard.dataset.path = next.path;
  el.fvCard.dataset.projectId = next.projectId || '';
  el.fvCard.classList.remove('unavailable');
  el.fvCard.setAttribute('aria-label', `可拖拽卡：${next.name}，按住拖进剪映`);
  el.fvCard.title = next.path;
  if (el.fvPreview.dataset.src !== next.fileUrl) {
    el.fvPreview.dataset.src = next.fileUrl;
    // #t=0.001 让解码器停在首帧做封面；不自动播放、不出声，纯预览。
    el.fvPreview.src = `${next.fileUrl}#t=0.001`;
    setStageState('正在读取首帧…');
  }
  if (next.presentation) preparePresentation(next.presentation);
}

function renderUnavailable(message) {
  info = null;
  document.body.dataset.ready = 'failed';
  document.body.dataset.floatPath = '';
  el.fvCard.classList.add('unavailable');
  el.fvCard.removeAttribute('aria-label');
  el.fvName.textContent = message;
  el.fvName.title = message;
  el.fvKind.textContent = '视频已失效';
  setStageState(message, 'warn');
  el.fvPreview.removeAttribute('src');
  el.fvPreview.load();
}

async function readInfo({ silent = false } = {}) {
  if (!window.floatVideoAPI || typeof window.floatVideoAPI.getInfo !== 'function') {
    renderUnavailable('浮窗只在桌面版可用');
    return null;
  }
  if (!loading) {
    loading = window.floatVideoAPI.getInfo()
      .then(next => {
        if (next && next.path) render(next);
        else renderUnavailable('当前视频不可用');
        return next;
      })
      .catch(error => {
        // 主进程读到过期视频时会直接关窗并通知左栏；这里只把界面转入失效态，不重复关窗。
        renderUnavailable(readableError(error, '当前视频不可用'));
        if (!silent) showToast(readableError(error, '当前视频不可用'));
        return null;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

// —— 原生拖出 ——
el.fvCard.addEventListener('dragstart', event => {
  if (!info || !window.floatVideoAPI || typeof window.floatVideoAPI.startAssetDrag !== 'function') {
    // 没有可信视频信息时不发起任何拖拽，也不让 HTML5 把 <video> 拖成临时文件。
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'none';
    if (!info) showToast('浮窗里没有可拖出的视频');
    return;
  }
  event.preventDefault();
  window.floatVideoAPI.startAssetDrag(info.path);
});

if (window.floatVideoAPI && typeof window.floatVideoAPI.onDragResult === 'function') {
  window.floatVideoAPI.onDragResult(result => {
    if (result && result.ok) showToast('已开始拖拽，松手放入剪映');
    else if (result) {
      const message = readableError({ message: result.error }, '拖拽未完成');
      showToast(message);
      if (message.includes('不属于当前剧本')) readInfo({ silent: true });
    }
  });
}

// —— 首帧预览状态 ——
el.fvPreview.addEventListener('loadeddata', () => setStageState(''));
el.fvPreview.addEventListener('canplay', () => setStageState(''));
el.fvPreview.addEventListener('error', () => {
  if (info) setStageState('首帧预览读取失败，拖拽仍可用', 'warn');
});

// —— 唯一关闭按钮 ——
el.fvClose.addEventListener('click', () => {
  if (window.floatVideoAPI && typeof window.floatVideoAPI.closeWindow === 'function') {
    window.floatVideoAPI.closeWindow();
  }
});

// —— 标题栏拖动兜底 ——
// 原生 -webkit-app-region: drag 生效时指针事件不会到达页面，两条路径不会叠加。
const fvHead = document.querySelector('.fv-head');
let windowDrag = null;
fvHead.addEventListener('pointerdown', event => {
  if (event.target.closest('.fv-close')) return;
  if (!window.floatVideoAPI || typeof window.floatVideoAPI.moveWindow !== 'function') return;
  if (typeof event.screenX !== 'number') return;
  windowDrag = { x: event.screenX, y: event.screenY };
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
});
fvHead.addEventListener('pointermove', event => {
  if (!windowDrag) return;
  const dx = Math.round(event.screenX - windowDrag.x);
  const dy = Math.round(event.screenY - windowDrag.y);
  windowDrag.x = event.screenX;
  windowDrag.y = event.screenY;
  if (dx || dy) window.floatVideoAPI.moveWindow(dx, dy);
});
const endWindowDrag = () => { windowDrag = null; };
fvHead.addEventListener('pointerup', endWindowDrag);
fvHead.addEventListener('pointercancel', endWindowDrag);

// —— 回到前台时对齐当前剧本：切剧本后主进程会拒读并关窗 ——
window.addEventListener('focus', () => { readInfo({ silent: true }); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) readInfo({ silent: true }); });

// 只读观测口（定向测试/诊断用，不参与任何业务判断）
window.__floatVideoDebug = () => ({
  ready: document.body.dataset.ready || '',
  path: info ? info.path : '',
  projectId: info ? info.projectId : '',
  name: info ? info.name : '',
  draggable: el.fvCard.getAttribute('draggable'),
  closeButtons: document.querySelectorAll('.fv-close, #fvClose').length,
  previewSrc: el.fvPreview.getAttribute('src') || '',
});

readInfo();
