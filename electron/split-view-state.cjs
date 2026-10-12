'use strict';

// 双拼只描述当前运行会话要挂哪两个已有标签、焦点在哪一侧、左右各占多宽。
// 不创建 WebContents、不写 browser-session、不决定网页是否接受拖入的文件。

const SPLIT_GUTTER = 4;
const SPLIT_RATIO_MIN = 0.2;
const SPLIT_RATIO_MAX = 0.8;
const SPLIT_RATIO_DEFAULT = 0.5;

function disabledSplit() {
  return {
    enabled: false,
    leftTabId: null,
    rightTabId: null,
    focusedPane: 'left',
    ratio: SPLIT_RATIO_DEFAULT,
    gutter: SPLIT_GUTTER,
  };
}

function clampSplitRatio(value) {
  if (value === undefined || value === null || value === '') return SPLIT_RATIO_DEFAULT;
  const number = Number(value);
  if (!Number.isFinite(number)) return SPLIT_RATIO_DEFAULT;
  if (number < SPLIT_RATIO_MIN) return SPLIT_RATIO_MIN;
  if (number > SPLIT_RATIO_MAX) return SPLIT_RATIO_MAX;
  return number;
}

function finiteInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number);
}

function normalizeState(state) {
  const ratio = clampSplitRatio(state && state.ratio);
  const disabled = { ...disabledSplit(), ratio };
  if (!state || typeof state !== 'object' || !state.enabled) return disabled;
  const leftTabId = typeof state.leftTabId === 'string' && state.leftTabId ? state.leftTabId : '';
  const rightTabId = typeof state.rightTabId === 'string' && state.rightTabId ? state.rightTabId : '';
  if (!leftTabId || !rightTabId || leftTabId === rightTabId) return disabled;
  return {
    enabled: true,
    leftTabId,
    rightTabId,
    focusedPane: state.focusedPane === 'right' ? 'right' : 'left',
    ratio,
    gutter: SPLIT_GUTTER,
  };
}

function disableSplit(state) {
  return { ...disabledSplit(), ratio: clampSplitRatio(state && state.ratio) };
}

function publicSplit(state) {
  const normalized = normalizeState(state);
  return {
    enabled: normalized.enabled,
    leftTabId: normalized.enabled ? normalized.leftTabId : null,
    rightTabId: normalized.enabled ? normalized.rightTabId : null,
    focusedPane: normalized.enabled && normalized.focusedPane === 'right' ? 'right' : 'left',
    ratio: normalized.ratio,
    gutter: SPLIT_GUTTER,
  };
}

// 分屏区域已经扣过 push 面板。两栏宽度加间隙必须正好等于区域宽度，且不能伸出区域。
// 极窄区域的分隔条缩小到剩余宽度，避免把右栏推出去。
function paneBounds(region, ratio) {
  const x = finiteInt(region && region.x);
  const y = finiteInt(region && region.y);
  const width = Math.max(0, finiteInt(region && region.width));
  const height = Math.max(0, finiteInt(region && region.height));
  const gutter = Math.min(SPLIT_GUTTER, width);
  const inner = width - gutter;
  let leftWidth = Math.round(inner * clampSplitRatio(ratio));
  if (leftWidth < 0) leftWidth = 0;
  if (leftWidth > inner) leftWidth = inner;
  const rightWidth = inner - leftWidth;
  return {
    left: { x, y, width: leftWidth, height },
    right: { x: x + leftWidth + gutter, y, width: rightWidth, height },
    gutter,
    width,
    height,
  };
}

function visiblePaneIds(state) {
  const normalized = normalizeState(state);
  return normalized.enabled ? [normalized.leftTabId, normalized.rightTabId] : [];
}

function asTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.filter(tab => tab && typeof tab.id === 'string' && tab.id).map(tab => ({
    id: tab.id,
    mode: tab.mode === 'video' ? 'video' : 'image',
    serviceId: typeof tab.serviceId === 'string' ? tab.serviceId : '',
    alive: tab.alive !== false,
  }));
}

function rejectLocalServiceToken(serviceId) {
  const id = String(serviceId || '').trim();
  if (!id) return '';
  // 服务 ID 只能是已配置网站的标识。file/http/绝对路径都不能当成新标签地址。
  if (/^[a-z][a-z\d+.-]*:/i.test(id) || id.includes('://') || id.startsWith('/') || id.startsWith('\\') || id.includes('\\') || id.includes('..')) {
    throw new Error('不能用本地文件地址打开双拼网页');
  }
  return id;
}

function planSetSplitView({ state, payload, activeTabId, activeMode, tabs, serviceAllowed } = {}) {
  const current = normalizeState(state);
  const request = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  if (!request) throw new Error('双拼参数无效');
  if (request.enabled === false) {
    return { action: 'disable', state: disableSplit(current), reload: false, closeTabs: false };
  }
  const list = asTabs(tabs);
  const byId = new Map(list.map(tab => [tab.id, tab]));
  const primaryId = String(request.primaryTabId || activeTabId || '').trim();
  const primary = byId.get(primaryId);
  if (!primary || !primary.alive) throw new Error(primaryId ? '这个网页已关闭' : '请先打开一个网页');
  const mode = primary.mode;
  const safeActiveMode = activeMode === 'video' ? 'video' : 'image';
  if (mode !== safeActiveMode) throw new Error('请先切换到这个标签所属的创作模式');
  if (typeof serviceAllowed === 'function' && !serviceAllowed(mode, primary.serviceId)) {
    throw new Error('该平台不属于当前创作模式');
  }

  const secondaryId = String(request.secondaryTabId || '').trim();
  const requestedServiceId = String(request.serviceId || '').trim();
  let rightTabId = null;
  let createServiceId = '';
  if (secondaryId) {
    const secondary = byId.get(secondaryId);
    if (!secondary || !secondary.alive) throw new Error('要并排的网页已关闭');
    if (secondary.id === primary.id) throw new Error('双拼需要左右两个不同的网页');
    if (secondary.mode !== mode) throw new Error('两个网页必须属于同一创作模式');
    if (typeof serviceAllowed === 'function' && !serviceAllowed(secondary.mode, secondary.serviceId)) {
      throw new Error('该平台不属于当前创作模式');
    }
    rightTabId = secondary.id;
  } else if (requestedServiceId) {
    createServiceId = rejectLocalServiceToken(requestedServiceId);
    if (typeof serviceAllowed === 'function' && !serviceAllowed(mode, createServiceId)) {
      throw new Error('该平台不属于当前创作模式');
    }
  } else {
    const other = list.find(tab => tab.alive && tab.id !== primary.id && tab.mode === mode
      && (typeof serviceAllowed !== 'function' || serviceAllowed(tab.mode, tab.serviceId)));
    if (!other) throw new Error('请选择另一个网页，或指定要新开的网站');
    rightTabId = other.id;
  }

  return {
    action: 'enable',
    createServiceId,
    leftTabId: primary.id,
    rightTabId,
    mode,
    ratio: current.ratio,
    reload: false,
    closeTabs: false,
  };
}

function planSetRatio(state, ratio) {
  const current = normalizeState(state);
  return { ...current, ratio: clampSplitRatio(ratio), gutter: SPLIT_GUTTER };
}

function planFocusPane(state, pane) {
  const current = normalizeState(state);
  if (!current.enabled) throw new Error('当前没有并排网页');
  if (pane !== 'left' && pane !== 'right') throw new Error('并排焦点只能是左侧或右侧');
  const tabId = pane === 'left' ? current.leftTabId : current.rightTabId;
  if (!tabId) throw new Error('这个网页已关闭');
  return {
    action: 'focus',
    pane,
    tabId,
    state: { ...current, focusedPane: pane },
    reload: false,
    closeTabs: false,
  };
}

function planActivateTab(state, tab, tabs) {
  const current = normalizeState(state);
  if (!current.enabled) return { action: 'single', state: current, reload: false, closeTabs: false };
  const list = asTabs(tabs);
  const left = list.find(item => item.id === current.leftTabId);
  const right = list.find(item => item.id === current.rightTabId);
  if (!left || !right || !left.alive || !right.alive || left.mode !== right.mode) {
    return { action: 'exit', state: disableSplit(current), reload: false, closeTabs: false };
  }
  if (!tab || tab.alive === false || typeof tab.id !== 'string') {
    return { action: 'single', state: current, reload: false, closeTabs: false };
  }
  const mode = tab.mode === 'video' ? 'video' : 'image';
  if (mode !== left.mode) return { action: 'exit', state: disableSplit(current), reload: false, closeTabs: false };
  if (tab.id === current.leftTabId) {
    return { action: 'focus', pane: 'left', state: { ...current, focusedPane: 'left' }, reload: false, closeTabs: false };
  }
  if (tab.id === current.rightTabId) {
    return { action: 'focus', pane: 'right', state: { ...current, focusedPane: 'right' }, reload: false, closeTabs: false };
  }
  const pane = current.focusedPane === 'right' ? 'right' : 'left';
  const next = { ...current, focusedPane: pane };
  if (pane === 'right') next.rightTabId = tab.id;
  else next.leftTabId = tab.id;
  if (next.leftTabId === next.rightTabId) return { action: 'exit', state: disableSplit(current), reload: false, closeTabs: false };
  return { action: 'replace', pane, state: next, reload: false, closeTabs: false };
}

function planTabDestroyed(state, tabId) {
  const current = normalizeState(state);
  if (!current.enabled || (tabId !== current.leftTabId && tabId !== current.rightTabId)) {
    return { changed: false, state: current, survivorId: '', reload: false, closeTabs: false };
  }
  const survivorId = tabId === current.leftTabId ? current.rightTabId : current.leftTabId;
  return {
    changed: true,
    survivorId,
    state: disableSplit(current),
    reload: false,
    closeTabs: false,
  };
}

function planExit(state) {
  return { action: 'exit', state: disableSplit(state), reload: false, closeTabs: false };
}

module.exports = {
  SPLIT_GUTTER,
  SPLIT_RATIO_MIN,
  SPLIT_RATIO_MAX,
  SPLIT_RATIO_DEFAULT,
  disabledSplit,
  clampSplitRatio,
  disableSplit,
  publicSplit,
  paneBounds,
  visiblePaneIds,
  planSetSplitView,
  planSetRatio,
  planFocusPane,
  planActivateTab,
  planTabDestroyed,
  planExit,
};
