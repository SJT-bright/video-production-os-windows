"""Geometry/pixel regression against the real creator UI, with isolated fixture APIs."""
import argparse
import io
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
parser.add_argument('--evidence', required=True)
args = parser.parse_args()
evidence = Path(args.evidence)
evidence.mkdir(parents=True, exist_ok=False)
project = {'id': 'split-layout-fixture', 'name': '隔离双拼', 'folder': '隔离双拼', 'categories': []}
errors, checks = [], []

with sync_playwright() as p:
    chrome_path = os.environ.get('PLAYWRIGHT_CHROME_PATH')
    browser = p.chromium.launch(headless=True, **({'executable_path': chrome_path} if chrome_path else {}))
    try:
        context = browser.new_context(viewport={'width': 1281, 'height': 861})

        def api(route):
            endpoint = urlparse(route.request.url).path
            data = {'ok': True}
            if endpoint == '/api/creative-assets':
                data = {'available': True, 'project': project, 'stats': {'files': 0},
                        'tree': {'kind': 'folder', 'name': project['name'], 'path': project['folder'], 'children': []}}
            elif endpoint == '/api/creative-projects':
                data = {'activeProjectId': project['id'], 'projects': [project]}
            elif endpoint == '/api/production':
                data = {'available': False, 'inbox': [], 'stats': {}}
            elif endpoint == '/api/events':
                route.fulfill(status=200, content_type='text/event-stream', body='')
                return
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

        context.route('**/api/**', api)
        context.add_init_script("""(() => {
          const callbacks = {}, project = PROJECT;
          const state = {mode:'image',serviceId:'gpt',tabId:'left',url:'about:blank',
            tabs:[{id:'left',serviceId:'gpt',mode:'image',url:'about:blank'}, {id:'right',serviceId:'gemini',mode:'image',url:'about:blank'}],
            split:{enabled:true,leftTabId:'left',rightTabId:'right',focusedPane:'left',ratio:.5,gutter:4}};
          const services=[{id:'gpt',label:'GPT',imageLabel:'GPT 图片',url:'about:blank'}, {id:'gemini',label:'Gemini',url:'about:blank'}];
          window.__emitBackdrop = value => callbacks.onPlatformBackdrop?.(value);
          const target = {
            getConfig:async()=>({project,services,modeServices:{image:['gpt','gemini'],video:['gpt','gemini']},
              defaults:{image:'gpt',video:'gpt'},paths:{creativeAssetAvailable:true},panel:{open:false,width:500},browser:state}),
            getDownloads:async()=>[],setBrowserBounds:async value=>value,
            setMode:async mode=>{state.mode=mode;state.tabs.forEach(t=>t.mode=mode);callbacks.onBrowserState?.(structuredClone(state));return structuredClone(state)},
            setAssetPanel:async value=>({...value,creativeAssetAvailable:true}),
            setSplitRatio:async ratio=>{state.split.ratio=ratio;callbacks.onBrowserState?.(structuredClone(state));return structuredClone(state)},
            setPlatformViewHidden:async()=>structuredClone(state)
          };
          window.creatorAPI = new Proxy(target,{get:(obj,key)=>key in obj ? obj[key] : String(key).startsWith('on') ? cb=>{callbacks[key]=cb;return()=>{}} : async()=>undefined});
        })();""".replace('PROJECT', json.dumps(project, ensure_ascii=False)))
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(args.base + '/creator.html?mode=image')
        page.wait_for_load_state('networkidle')
        expect(page.locator('body')).to_have_attribute('data-ready', 'true')
        sequence = 0

        for viewport in [{'width': 1281, 'height': 861}, {'width': 1464, 'height': 902}]:
            page.set_viewport_size(viewport)
            for ratio in [.35, .5, .67]:
                page.evaluate('ratio => window.creatorAPI.setSplitRatio(ratio)', ratio)
                page.wait_for_timeout(80)
                geometry = page.evaluate("""() => {
                  const stage=document.getElementById('browserStage').getBoundingClientRect(), gutter=document.getElementById('splitGutter');
                  const bounds=gutter.getBoundingClientRect(), css=getComputedStyle(gutter);
                  return {stage:{x:stage.x,y:stage.y,width:stage.width,height:stage.height},gutter:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},
                    background:css.backgroundColor,placeholder:getComputedStyle(document.querySelector('.browser-placeholder')).visibility};
                }""")
                s, g = geometry['stage'], geometry['gutter']
                # JavaScript rounding, not Python's round-to-even.
                rounded = lambda n: int(n + .5)
                width, height = rounded(s['width']), rounded(s['height'])
                left_width = rounded((width - 4) * ratio)
                assert abs(g['x'] - (rounded(s['x']) + left_width)) < .02, geometry
                assert g['width'] == 4 and g['height'] == height, geometry
                assert geometry['background'] == 'rgb(217, 217, 222)' and geometry['placeholder'] == 'hidden'
                sequence += 1
                page.evaluate("""({sequence,width,height,left}) => {
                  const image=color=>{const c=document.createElement('canvas');c.width=c.height=1;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,1,1);return c.toDataURL()};
                  window.__emitBackdrop({sequence,region:{width,height},frames:[
                    {pane:'left',image:image('#dbedff'),bounds:{x:0,y:0,width:left,height}},
                    {pane:'right',image:image('#fff0d9'),bounds:{x:left+4,y:0,width:width-left-4,height}}
                  ]});
                }""", {'sequence': sequence, 'width': width, 'height': height, 'left': left_width})
                page.wait_for_function("[...document.querySelectorAll('#platformBackdropLayer img')].every(img=>img.complete&&img.naturalWidth)")
                screenshot = page.screenshot()
                pixels = Image.open(io.BytesIO(screenshot)).convert('RGB')
                y = rounded(g['y']) + min(300, height - 20)
                seam_x = rounded(g['x'])
                assert pixels.getpixel((seam_x, y)) == (217, 217, 222)
                assert pixels.getpixel((seam_x - 20, y)) == (219, 237, 255)
                assert pixels.getpixel((seam_x + 20, y)) == (255, 240, 217)
                checks.append({'viewport': viewport, 'ratio': ratio, 'geometry': geometry, 'pixels': 'left/seam/right passed'})
                if ratio == .5 and viewport['width'] == 1464:
                    (evidence / 'split-background.png').write_bytes(screenshot)

        page.locator('#splitReplace').click()
        expect(page.locator('#splitPickerDialog')).to_be_visible()
        expect(page.locator('#platformBackdropLayer')).to_be_visible()
        page.evaluate("document.getElementById('splitPickerDialog').close()")
        expect(page.locator('#splitPickerDialog')).not_to_be_visible()
        sequence += 1
        page.evaluate('sequence => window.__emitBackdrop({sequence,frames:[],image:""})', sequence)
        expect(page.locator('#platformBackdropLayer')).not_to_be_visible()
        page.evaluate('sequence => window.__emitBackdrop({sequence:sequence-1,image:"data:image/png;base64,stale"})', sequence)
        expect(page.locator('#platformBackdropLayer')).not_to_be_visible()
        expanded_width = page.locator('#promptPanel').bounding_box()['width']
        page.locator('#promptAccordion > summary').click()
        page.locator('#promptEditor').fill('侧栏草稿保持')
        accordion_states = page.evaluate("['promptAccordion','scriptAccordion','assetAccordion'].map(id=>document.getElementById(id).open)")
        page.locator('#collapseMaterialSidebar').click()
        expect(page.locator('#collapseMaterialSidebar')).to_have_attribute('aria-expanded', 'false')
        assert page.locator('#promptPanel').bounding_box()['width'] == 48
        page.locator('.mode-button[data-mode="video"]').click()
        expect(page.locator('#togglePrompt')).to_have_attribute('aria-expanded', 'false')
        page.reload()
        page.wait_for_load_state('networkidle')
        expect(page.locator('body')).to_have_attribute('data-ready', 'true')
        assert page.locator('#promptPanel').bounding_box()['width'] == 48
        expect(page.locator('#collapseMaterialSidebar')).to_be_visible()
        page.locator('#collapseMaterialSidebar').focus()
        page.keyboard.press('Enter')
        expect(page.locator('#togglePrompt')).to_have_attribute('aria-expanded', 'true')
        assert page.locator('#promptPanel').bounding_box()['width'] == expanded_width
        assert page.evaluate("['promptAccordion','scriptAccordion','assetAccordion'].map(id=>document.getElementById(id).open)") == accordion_states
        expect(page.locator('#promptEditor')).to_have_value('侧栏草稿保持')
        page.locator('#togglePrompt').click()
        assert page.locator('#promptPanel').bounding_box()['width'] == 48
        page.screenshot(path=str(evidence / 'collapsed-sidebar.png'))
        assert not errors, errors
        (evidence / 'receipt.json').write_text(json.dumps({'status': 'passed', 'checks': checks,
            'modalChooser': True, 'staleCaptureRejected': True, 'sidebarControlsAndPersistence': True, 'pageErrors': errors, 'scope': 'isolated browser UI fixtures, not native views'}, ensure_ascii=False, indent=2))
        print('SPLIT_BACKDROP_UI_PASS geometry=6 pixels=6 chooser=true staleCaptureRejected=true sidebarPersistence=true')
    finally:
        browser.close()
