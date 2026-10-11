"""分类改名 UI 回归；隔离接口和存储，不读取正式素材。"""
import argparse
import json
import os
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
args = parser.parse_args()
project = {'id': 'project-folder-ui', 'name': '测试剧本', 'folder': '测试剧本', 'categories': []}

with sync_playwright() as p:
    chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = p.chromium.launch(headless=True, executable_path=chrome if os.path.isfile(chrome) else None)
    errors = []
    for surface in ['image', 'video', 'library']:
        context = browser.new_context(viewport={'width': 1320, 'height': 860})
        current = {'name': '成片'}

        def api(route):
            endpoint = urlparse(route.request.url).path
            data = {'ok': True}
            if endpoint == '/api/creative-assets':
                data = {'available': True, 'project': project, 'stats': {'files': 0}, 'tree': {
                    'kind': 'folder', 'name': project['name'], 'path': project['folder'], 'fileCount': 0,
                    'children': [{'kind': 'folder', 'name': name, 'path': project['folder'] + '/' + name, 'fileCount': 0, 'children': []}
                                 for name in [current['name'], '人物资产']]}}
            elif endpoint == '/api/creative-projects':
                data = {'activeProjectId': project['id'], 'projects': [project]}
            elif endpoint == '/api/production': data = {'available': False, 'inbox': [], 'stats': {}}
            elif endpoint == '/api/events':
                route.fulfill(status=200, content_type='text/event-stream', body='')
                return
            route.fulfill(status=200, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

        def rename(request):
            if request['name'] == '人物资产': raise ValueError('同名文件夹已经存在')
            current['name'] = request['name']
            return {'projectId': project['id'], 'oldPath': request['path'], 'path': project['folder'] + '/' + request['name'], 'name': request['name']}

        context.route('**/api/**', api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_function('__renameFixture', rename)
        page.add_init_script("""(() => {
          const project = PROJECT;
          const service={id:'gpt',label:'GPT',imageLabel:'GPT 图片',videoLabel:'GPT 提示词',url:'about:blank'};
          const state=mode=>({mode,serviceId:'gpt',tabs:[],url:'about:blank'});
          const target={
            getConfig:async()=>({project,services:[service],modeServices:{image:['gpt'],video:['gpt']},defaults:{image:'gpt',video:'gpt'},paths:{creativeAssetAvailable:true},panel:{open:true,width:500},browser:state('image')}),
            getDownloads:async()=>[],setMode:async mode=>state(mode),
            showFolderMenu:async request=>({rename:true,path:request.path,name:request.path.split('/').pop(),projectId:project.id}),
            renameFolder: request=>window.__renameFixture(request),
            setAssetPanel:async value=>({...value,creativeAssetAvailable:true})
          };
          const api = new Proxy(target,{get:(obj,key)=>key in obj?obj[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
          window.creatorAPI=api; window.assetAPI=api;
          localStorage.setItem('videoOS.assetFolderOrder.v1.'+project.id, JSON.stringify({[project.folder]:[project.folder+'/成片',project.folder+'/人物资产']}));
        })();""".replace('PROJECT', json.dumps(project, ensure_ascii=False)))
        page.goto(args.base + ('/creator-assets.html?surface=library' if surface == 'library' else '/creator.html?mode=' + surface))
        page.wait_for_load_state('networkidle')
        expect(page.locator('body')).to_have_attribute('data-ready', 'true')
        row_class = '.folder-row' if surface == 'library' else '.quick-folder-row'
        print('FOLDER_UI_DOM', surface, page.locator(row_class).all_text_contents())
        row = page.locator(row_class + '[data-folder-path="测试剧本/成片"]')
        row.click(button='right')
        field = page.get_by_role('textbox', name='文件夹名称', exact=True)
        expect(field).to_be_visible()
        assert field.bounding_box()['height'] <= row.bounding_box()['height'] + 6
        field.fill('取消编辑'); field.press('Escape')
        expect(field).to_have_count(0)
        assert current['name'] == '成片'
        row.click(button='right'); field.fill('人物资产'); field.press('Enter')
        expect(field).to_have_attribute('aria-invalid', 'true')
        field.fill('最后的成品'); field.press('Enter')
        expect(page.locator(row_class + '[data-folder-path="测试剧本/最后的成品"]')).to_be_visible()
        expect(field).to_have_count(0)
        saved = page.evaluate("JSON.parse(localStorage.getItem('videoOS.assetFolderOrder.v1.project-folder-ui'))")
        assert saved['测试剧本'] == ['测试剧本/最后的成品', '测试剧本/人物资产']
        context.close()
    assert not errors, errors
    browser.close()
    print('FOLDER_UI_PASS: 图片/视频/完整库的右键、原位编辑、取消、错误重试、保存和排序保留')
