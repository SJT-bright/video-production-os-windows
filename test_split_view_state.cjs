'use strict';

const assert = require('assert/strict');
const {
  SPLIT_GUTTER,
  disabledSplit,
  clampSplitRatio,
  publicSplit,
  paneBounds,
  visiblePaneIds,
  planSetSplitView,
  planSetRatio,
  planFocusPane,
  planActivateTab,
  planTabDestroyed,
  planExit,
} = require('./electron/split-view-state.cjs');

const allowed = (mode, serviceId) => (mode === 'image' || mode === 'video') && (serviceId === 'gpt' || serviceId === 'grok');
const tabs = [
  { id: 'left', mode: 'image', serviceId: 'gpt', alive: true },
  { id: 'right', mode: 'image', serviceId: 'grok', alive: true },
  { id: 'third', mode: 'image', serviceId: 'gpt', alive: true },
  { id: 'video', mode: 'video', serviceId: 'gpt', alive: true },
  { id: 'dead', mode: 'image', serviceId: 'gpt', alive: false },
];

function enable(payload, extra = {}) {
  return planSetSplitView({
    state: disabledSplit(),
    payload,
    activeTabId: 'left',
    activeMode: 'image',
    tabs,
    serviceAllowed: allowed,
    ...extra,
  });
}

function opened(focusedPane = 'left') {
  return {
    enabled: true,
    leftTabId: 'left',
    rightTabId: 'right',
    focusedPane,
    ratio: 0.5,
    gutter: SPLIT_GUTTER,
  };
}

function assertCover(region, ratio) {
  const panes = paneBounds(region, ratio);
  const width = Math.max(0, Math.round(Number(region.width) || 0));
  const x = Math.round(Number(region.x) || 0);
  assert.equal(panes.left.width + panes.gutter + panes.right.width, width, `宽度 ${width} 未铺满`);
  assert.equal(panes.right.x + panes.right.width, x + width, `宽度 ${width} 右缘超出`);
  assert.ok(panes.left.width >= 0 && panes.right.width >= 0 && panes.gutter >= 0);
  assert.ok(panes.left.x >= x);
  assert.ok(panes.right.x >= panes.left.x + panes.left.width);
  assert.ok(panes.right.x + panes.right.width <= x + width);
  return panes;
}

assert.deepEqual(publicSplit(null), {
  enabled: false, leftTabId: null, rightTabId: null, focusedPane: 'left', ratio: 0.5, gutter: SPLIT_GUTTER,
});
assert.deepEqual(visiblePaneIds(disabledSplit()), []);

assert.equal(clampSplitRatio(undefined), 0.5);
assert.equal(clampSplitRatio(Number.NaN), 0.5);
assert.equal(clampSplitRatio(Infinity), 0.5);
assert.equal(clampSplitRatio(0.1), 0.2);
assert.equal(clampSplitRatio(0.9), 0.8);
assert.equal(clampSplitRatio(0.35), 0.35);
assert.deepEqual(planSetRatio(opened(), '0.1').ratio, 0.2);
assert.equal(planSetRatio(disabledSplit(), 0.66).enabled, false);
assert.equal(planSetRatio(disabledSplit(), 0.66).ratio, 0.66);
assert.equal(publicSplit(planSetRatio(disabledSplit(), 0.66)).leftTabId, null);

for (const width of [0, 1, 7, 8, 9, 20, 120, 419, 901]) {
  for (const ratio of [0.2, 0.5, 0.8, 0.333]) {
    const panes = assertCover({ x: 410, y: 112, width, height: 700 }, ratio);
    if (width >= SPLIT_GUTTER) assert.equal(panes.gutter, SPLIT_GUTTER);
    else assert.equal(panes.gutter, width);
  }
}
const fractional = assertCover({ x: 10.6, y: 20.4, width: 100.2, height: 40.8 }, 0.2);
assert.equal(fractional.left.x, 11);
assert.equal(fractional.width, 100);
assert.equal(fractional.left.width + fractional.gutter + fractional.right.width, 100);

const paired = enable({ secondaryTabId: 'right' });
assert.equal(paired.action, 'enable');
assert.equal(paired.leftTabId, 'left');
assert.equal(paired.rightTabId, 'right');
assert.equal(paired.createServiceId, '');
assert.equal(paired.reload, false);
assert.equal(paired.closeTabs, false);
assert.equal(paired.url, undefined);
assert.deepEqual(visiblePaneIds({ ...opened(), ratio: paired.ratio }), ['left', 'right']);

const created = enable({ serviceId: 'grok', url: 'file:///tmp/secret.png', initialUrl: 'file:///tmp/other.png' });
assert.equal(created.createServiceId, 'grok');
assert.equal(created.rightTabId, null);
assert.equal(created.url, undefined);
assert.equal(created.initialUrl, undefined);

const picked = enable({});
assert.equal(picked.rightTabId, 'right');
assert.equal(enable({}, { activeTabId: 'right' }).leftTabId, 'right');
assert.equal(enable({}, { activeTabId: 'right' }).rightTabId, 'left');

const closed = enable({ enabled: false, secondaryTabId: 'missing', serviceId: 'file:///tmp/a' });
assert.equal(closed.action, 'disable');
assert.equal(closed.reload, false);
assert.equal(closed.closeTabs, false);
assert.deepEqual(publicSplit(closed.state), { ...disabledSplit(), ratio: 0.5 });

for (const [payload, message] of [
  [{ primaryTabId: 'missing', secondaryTabId: 'right' }, /已关闭/],
  [{ primaryTabId: 'dead', secondaryTabId: 'right' }, /已关闭/],
  [{ secondaryTabId: 'left' }, /两个不同/],
  [{ secondaryTabId: 'video' }, /同一创作模式/],
  [{ secondaryTabId: 'nope' }, /已关闭/],
  [{ serviceId: 'file:///tmp/a.png' }, /本地文件/],
  [{ serviceId: 'https://evil.example/a' }, /本地文件/],
  [{ serviceId: '/tmp/a.png' }, /本地文件/],
  [{ serviceId: 'javascript:alert(1)' }, /本地文件/],
  [{ serviceId: 'unknown' }, /不属于当前创作模式/],
  [{}, /另一个网页/],
]) {
  if (payload && Object.keys(payload).length === 0) {
    assert.throws(() => enable(payload, { tabs: [tabs[0]] }), message);
  } else {
    assert.throws(() => enable(payload), message);
  }
}
assert.throws(() => enable({ secondaryTabId: 'right' }, { activeMode: 'video', activeTabId: 'left' }), /创作模式/);
assert.throws(() => planSetSplitView({ state: disabledSplit(), payload: null }), /参数无效/);

const focusRight = planFocusPane(opened(), 'right');
assert.equal(focusRight.pane, 'right');
assert.equal(focusRight.tabId, 'right');
assert.equal(focusRight.state.leftTabId, 'left');
assert.equal(focusRight.state.rightTabId, 'right');
assert.equal(focusRight.reload, false);
assert.throws(() => planFocusPane(opened(), 'middle'), /左侧或右侧/);
assert.throws(() => planFocusPane(disabledSplit(), 'left'), /没有并排/);

const focusExisting = planActivateTab(opened('right'), { id: 'left', mode: 'image', alive: true }, tabs);
assert.equal(focusExisting.action, 'focus');
assert.equal(focusExisting.pane, 'left');
assert.deepEqual(visiblePaneIds(focusExisting.state), ['left', 'right']);
assert.equal(focusExisting.reload, false);

const replaceRight = planActivateTab(opened('right'), { id: 'third', mode: 'image', alive: true }, tabs);
assert.equal(replaceRight.action, 'replace');
assert.equal(replaceRight.pane, 'right');
assert.equal(replaceRight.state.leftTabId, 'left');
assert.equal(replaceRight.state.rightTabId, 'third');
assert.equal(replaceRight.closeTabs, false);

const replaceLeft = planActivateTab(opened('left'), { id: 'third', mode: 'image', alive: true }, tabs);
assert.equal(replaceLeft.state.leftTabId, 'third');
assert.equal(replaceLeft.state.rightTabId, 'right');

const leaveMode = planActivateTab(opened(), { id: 'video', mode: 'video', alive: true }, tabs);
assert.equal(leaveMode.action, 'exit');
assert.equal(leaveMode.state.enabled, false);
assert.equal(leaveMode.reload, false);
assert.equal(leaveMode.closeTabs, false);
assert.deepEqual(visiblePaneIds(leaveMode.state), []);

const closeLeft = planTabDestroyed(opened(), 'left');
assert.equal(closeLeft.changed, true);
assert.equal(closeLeft.survivorId, 'right');
assert.equal(closeLeft.state.enabled, false);
assert.equal(closeLeft.reload, false);
const closeRight = planTabDestroyed(opened(), 'right');
assert.equal(closeRight.survivorId, 'left');
const closeThird = planTabDestroyed(opened(), 'third');
assert.equal(closeThird.changed, false);
assert.deepEqual(visiblePaneIds(closeThird.state), ['left', 'right']);
const closeAgain = planTabDestroyed(closeLeft.state, 'right');
assert.equal(closeAgain.changed, false);

const exited = planExit(planSetRatio(opened(), 0.7));
assert.equal(exited.action, 'exit');
assert.equal(exited.state.enabled, false);
assert.equal(exited.state.leftTabId, null);
assert.equal(exited.state.rightTabId, null);
assert.equal(exited.state.ratio, 0.7);
assert.equal(exited.reload, false);
assert.equal(exited.closeTabs, false);

console.log('SPLIT_VIEW_STATE PASS: bounds, ratio, invalid ids, close, replace, focus');
