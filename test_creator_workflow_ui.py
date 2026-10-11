"""隔离静态 UI：分类框布局、来源锚点动画、拖动中断和减少动态效果；不访问正式会话。"""
import argparse
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
parser.add_argument('--out', default='test-artifacts/creator-workflow-ui')
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)

float_mock = """(() => {
  const handlers = {}, calls = [];
  window.__floatCalls = calls;
  window.__floatHandlers = handlers;
  window.floatVideoAPI = {
    getInfo: async () => ({path:'测试/生成视频/待处理/核绘/2026-10-08/生成视频-001.mp4', name:'生成视频-001.mp4', projectId:'test', projectName:'测试剧本', disposition:'processing', fileUrl:'/missing-preview.mp4',
      presentation:{id:'motion-test',left:600,top:120,width:384,height:336,dx:-500,dy:50,scaleX:140/384,scaleY:170/336,anchored:true}}),
    onPrepare: cb => {handlers.prepare=cb;}, onPresent: cb => {handlers.present=cb;}, onSettled: cb => {handlers.settled=cb;},
    readyToPresent: id => {calls.push(['ready',id]);window.__releaseReady=()=>handlers.present({id});},
    settlePresentation: id => {calls.push(['settle',id]);handlers.settled({id});},
    onDragResult: cb => {handlers.drag=cb;}, startAssetDrag: path => {calls.push(['drag',path]);},
    closeWindow: () => calls.push(['close']), moveWindow: (dx,dy) => calls.push(['move',dx,dy]),
  };
})();"""

with sync_playwright() as p:
    chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = p.chromium.launch(headless=True, executable_path=chrome if os.path.isfile(chrome) else None)
    errors = []
    context = browser.new_context(viewport={'width': 1000, 'height': 650}, reduced_motion='no-preference')
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script(float_mock)
    page.goto(args.base + '/float-video.html')
    page.wait_for_load_state('networkidle')
    page.wait_for_function('() => typeof window.__releaseReady === "function"')
    before = page.locator('#fvShell').bounding_box()
    for key, expected in {'x':100,'y':170,'width':140,'height':170}.items():
        assert abs(before[key] - expected) < .1, (key, before)
    page.screenshot(path=str(out / 'float-from-card.png'))
    trace = page.evaluate("""() => new Promise(resolve => {
      const frames=[]; let previous;
      window.__releaseReady();
      const tick = now => {if(previous!==undefined)frames.push(now-previous);previous=now;
        if(document.body.dataset.presenting==='false')resolve(frames);else requestAnimationFrame(tick);};
      requestAnimationFrame(tick);
    })""")
    assert len(trace) >= 8, trace
    assert max(trace) < 120, trace
    assert page.evaluate("window.__floatCalls.filter(call=>call[0]==='settle').length") == 1
    assert page.locator('#fvCard').get_attribute('draggable') == 'true'
    assert 'Updream' in page.locator('#fvKind').inner_text()
    assert page.locator('button').count() == 1

    # 重新浮出时点击卡片可立即中断，拖出无需等 300ms。
    page.evaluate("window.__floatHandlers.prepare({id:'interrupt',left:600,top:120,width:384,height:336,dx:-500,dy:50,scaleX:140/384,scaleY:170/336,anchored:true})")
    page.wait_for_function("() => window.__floatCalls.at(-1)?.[0] === 'ready'")
    page.evaluate("window.__releaseReady(); document.querySelector('#fvCard').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.querySelector('#fvCard').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true}));")
    calls = page.evaluate('window.__floatCalls')
    assert ['settle', 'interrupt'] in calls
    assert any(call[0] == 'drag' for call in calls)
    expect(page.locator('body')).to_have_attribute('data-presenting', 'false')

    reduced = browser.new_context(viewport={'width':1000,'height':650}, reduced_motion='reduce')
    reduced_page = reduced.new_page()
    reduced_page.add_init_script(float_mock)
    reduced_page.goto(args.base + '/float-video.html')
    reduced_page.wait_for_function('() => typeof window.__releaseReady === "function"')
    assert reduced_page.locator('#fvShell').evaluate("el=>getComputedStyle(el).transform") == 'none'
    reduced_page.evaluate('window.__releaseReady()')
    expect(reduced_page.locator('body')).to_have_attribute('data-presenting', 'false')

    choices = context.new_page()
    choices.on('pageerror', lambda error: errors.append(str(error)))
    choices.add_init_script("window.__choices=[];window.downloadReviewAPI={getInfo:async()=>({filename:'长名称视频.mp4',projectName:'测试剧本'}),choose:value=>window.__choices.push(value)}")
    choices.set_viewport_size({'width':560,'height':332})
    choices.goto(args.base + '/assets/ui/download-review.html')
    choices.wait_for_load_state('networkidle')
    assert choices.locator('[data-choice]').count() == 2
    editable, processing = [choices.locator('[data-choice="' + name + '"]').bounding_box() for name in ['editable','processing']]
    assert abs(editable['y'] - processing['y']) < 1
    assert editable['x'] + editable['width'] < processing['x']
    assert choices.evaluate('document.documentElement.scrollHeight <= innerHeight'), '分类框不能溢出需要滚动'
    choices.screenshot(path=str(out / 'download-choices.png'))
    choices.locator('[data-choice="processing"]').click()
    assert choices.evaluate('window.__choices') == ['processing']
    assert not errors, errors
    report = {'passed':True, 'anchoredOrigin':before, 'frameCount':len(trace), 'maximumFrameGapMs':round(max(trace),2),
              'reducedMotion':True, 'interruptibleDrag':True, 'twoChoicesSameRow':True, 'errors':errors}
    (out / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print('WORKFLOW_UI_PASS', json.dumps(report, ensure_ascii=False))
    browser.close()
