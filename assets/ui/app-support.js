'use strict';
(() => {
  const api = window.desktopOS;
  const native = typeof api?.getAppReleaseState === 'function';
  let state = null, busy = false;
  function receive(next) {
    if (!next || (Number.isFinite(state?.revision) && Number.isFinite(next.revision) && next.revision < state.revision)) return;
    state = next; render();
  }
  const announcement = document.createElement('span');
  announcement.className = 'app-support-announcement'; announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite'); document.body.appendChild(announcement);
  function renderStar(anchor) {
    if (state?.starUrl) anchor.href = state.starUrl;
    anchor.title = '打开官方GitHub仓库，点击右上角Star支持作者';
    anchor.setAttribute('aria-label', 'GitHub Star，支持作者');
  }
  function render() {
    document.querySelectorAll('[data-app-star]').forEach(renderStar);
    document.querySelectorAll('[data-app-update]').forEach(button => {
      const label = button.querySelector('[data-app-update-label]');
      button.disabled = !native || busy || state?.checking || state?.supported === false;
      button.dataset.updateAvailable = String(!!state?.available);
      if (label) label.textContent = !native ? '下载新版' : busy || state?.checking ? '检查中…'
        : state?.available ? `更新 v${state.release.version}` : state?.status === 'error' ? '重试更新'
          : state?.currentVersion ? `v${state.currentVersion}` : '检查更新';
      button.title = !native ? '自动检查更新需要桌面版；可从旁边GitHub入口下载'
        : state?.supported === false ? state.disabledReason || '当前系统架构暂无对应正式安装包'
        : state?.available ? `发现 v${state.release.version}，点击打开官方更新下载页；不会自动退出软件`
          : state?.error || '点击检查GitHub正式版；软件启动后及每6小时也会自动检查';
      button.setAttribute('aria-label', state?.available ? `更新到 v${state.release.version}` : '检查软件更新');
    });
    if (state?.available) announcement.textContent = `视频制作 OS 发现新版 v${state.release.version}，可点击更新按钮下载`;
  }
  document.addEventListener('click', async event => {
    const star = event.target.closest?.('[data-app-star]');
    if (star && native && typeof api.openGitHubStar === 'function') {
      event.preventDefault();
      try { await api.openGitHubStar(); } catch { window.open(star.href, '_blank', 'noopener,noreferrer'); }
      return;
    }
    const update = event.target.closest?.('[data-app-update]');
    if (!update || !native || busy || state?.checking) return;
    busy = true; render();
    try {
      if (state?.available) await api.openAppRelease();
      else { const result = await api.checkAppUpdates(); if (result) receive(result); }
    } catch (error) {
      state = { ...state, status: 'error', error: String(error.message || '暂时无法检查更新') };
      announcement.textContent = state.error;
    } finally { busy = false; render(); }
  });
  // The home launcher is rendered later than the static toolbar.
  const observer = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.matches('[data-app-star]')) renderStar(node);
      node.querySelectorAll('[data-app-star]').forEach(renderStar);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true });
  const unsubscribe = native && typeof api.onAppReleaseState === 'function' ? api.onAppReleaseState(receive) : null;
  window.addEventListener('pagehide', () => { observer.disconnect(); unsubscribe?.(); }, { once: true });
  render();
  if (native) api.getAppReleaseState().then(receive).catch(error => {
    state = { status: 'error', error: String(error.message || '检查更新尚未就绪') }; render();
  });
})();
