"""隔离整理 UI：所有 API、素材与 Electron 桥接均为内存夹具。"""
import argparse
import base64
import copy
import json
import time
from pathlib import Path
from urllib.parse import urlparse, quote
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
parser.add_argument('--artifacts', default='test-artifacts/asset-organization-ui')
args = parser.parse_args()
artifacts = Path(args.artifacts)
artifacts.mkdir(parents=True, exist_ok=True)
project = {'id': 'organization-fixture', 'name': '整理夹具', 'folder': '整理夹具', 'categories': []}
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')


def file(name, folder, number, kind='image'):
    return {'kind': 'file', 'type': kind, 'name': name, 'path': folder + '/' + name,
            'assetId': 'fixture-' + str(number), 'videoDisposition': 'editable' if kind == 'video' else None,
            'assetRole': 'source', 'sizeText': '1 KB', 'mtime': '2026-10-09T09:00:00Z'}


def folder(name, parent, children=None):
    return {'kind': 'folder', 'name': name, 'path': parent + '/' + name, 'children': children or [], 'fileCount': 0}


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    errors = []
    for surface in ['image', 'video', 'library']:
        tree = {'kind': 'folder', 'name': project['name'], 'path': project['folder'], 'fileCount': 4, 'children': [
            folder('生成图片', project['folder'], [folder('第01集', '整理夹具/生成图片', [
                file('母图.png', '整理夹具/生成图片/第01集', 1),
                file('失败.png', '整理夹具/生成图片/第01集', 2)])]),
            folder('生成视频', project['folder'], [folder('第01集', '整理夹具/生成视频', [
                file('已在目标.png', '整理夹具/生成视频/第01集', 3),
                file('预览.mp4', '整理夹具/生成视频/第01集', 4, 'video')])]),
            folder('2026-10-08', project['folder']), folder('2026-10-09', project['folder'])]}
        requests = {'tree': 0, 'folder': [], 'move': [], 'copy': []}

        def nodes(node=None):
            node = node or tree
            yield node
            for child in node.get('children', []):
                yield from nodes(child)

        def find(path):
            return next((node for node in nodes() if node['path'] == path), None)

        def api(route):
            endpoint = urlparse(route.request.url).path
            data, status = {'ok': True}, 200
            if endpoint == '/api/creative-assets':
                requests['tree'] += 1
                data = {'available': True, 'project': project, 'stats': {'files': 4}, 'tree': tree}
            elif endpoint == '/api/creative-projects':
                data = {'activeProjectId': project['id'], 'projects': [project]}
            elif endpoint == '/api/production':
                data = {'available': False, 'inbox': [], 'stats': {}}
            elif endpoint == '/api/creative-assets/file':
                route.fulfill(status=200, content_type='image/png', body=png)
                return
            elif endpoint == '/api/creative-assets/folder':
                body = route.request.post_data_json
                requests['folder'].append(body)
                parent = find(body['parent'])
                new_path = body['parent'] + '/' + body['name']
                if find(new_path):
                    status, data = 409, {'error': '同名文件夹已经存在'}
                else:
                    child = folder(body['name'], body['parent'])
                    parent['children'].append(child)
                    data = {'ok': True, 'folder': child}
            elif endpoint in ['/api/creative-assets/move', '/api/creative-assets/copy']:
                action = endpoint.rsplit('/', 1)[1]
                body = route.request.post_data_json
                requests[action].append(body)
                time.sleep(.23)  # 多于旧 SSE 防抖窗口，证明批次内不逐项刷新。
                item = find(body['path'])
                if item['name'] == '失败.png':
                    status, data = 400, {'error': '夹具拒绝此项'}
                else:
                    old_path = item['path']
                    if action == 'copy':
                        item = copy.deepcopy(item)
                        item['assetId'] += '-copy'
                    else:
                        find(old_path.rsplit('/', 1)[0])['children'].remove(item)
                    item['path'] = body['folder'] + '/' + item['name']
                    find(body['folder'])['children'].append(item)
                    data = {'ok': True, 'oldPath': old_path, 'path': item['path'], 'name': item['name'],
                            'folder': body['folder'], 'assetId': item['assetId'], 'videoDisposition': item.get('videoDisposition')}
            route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

        context = browser.new_context(viewport={'width': 1320, 'height': 860})
        context.route('**/api/**', api)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.add_init_script("""(() => {
          const project = PROJECT;
          const service={id:'gpt',label:'GPT',imageLabel:'GPT 图片',videoLabel:'GPT 提示词',url:'about:blank'};
          const browser=mode=>({mode,serviceId:'gpt',tabs:[],url:'about:blank'});
          window.__folderMenuRequests=[]; window.__floatRequests=[];
          const target={
            getConfig:async()=>({project,candidate:{id:'organization-ui',version:'1.2.4-candidate'},services:[service],modeServices:{image:['gpt'],video:['gpt']},defaults:{image:'gpt',video:'gpt'},paths:{creativeAssetAvailable:true},panel:{open:true,width:500},browser:browser('image')}),
            getDownloads:async()=>[],setMode:async mode=>browser(mode),
            showFolderMenu:async request=>{window.__folderMenuRequests.push(request);return {create:true,parent:request.path,projectId:project.id};},
            floatVideoAsset:async request=>{window.__floatRequests.push(request);return {path:request.path};},
            setAssetPanel:async value=>({...value,creativeAssetAvailable:true})
          };
          const api = new Proxy(target,{get:(obj,key)=>key in obj?obj[key]:String(key).startsWith('on')?()=>()=>{}:async()=>undefined});
          window.creatorAPI=api; window.assetAPI=api;
          window.__eventSources=[];
          window.EventSource=class {constructor(){this.listeners={};window.__eventSources.push(this);}addEventListener(type,fn){this.listeners[type]=fn;}close(){}};
          window.__emit=(type,data)=>window.__eventSources.forEach(source=>source.listeners[type]?.({data:JSON.stringify(data)}));
          const fetchOriginal=window.fetch;
          window.fetch=async(...args)=>{
            const response=await fetchOriginal(...args);
            if(/\/api\/creative-assets\/(move|copy)\?/.test(String(args[0]))){
              const data=await response.clone().json();
              if(response.ok){
                const moving=String(args[0]).includes('/move?');
                window.__emit('creative-assets',{projectId:project.id,...(moving?{moves:[data]}:{copies:[{sourcePath:data.oldPath,path:data.path,assetId:data.assetId}]})});
                setTimeout(()=>window.__emit('creative-assets',{projectId:project.id,...(moving?{moves:[data]}:{copies:[{sourcePath:data.oldPath,path:data.path,assetId:data.assetId}]})}),280);
              }
            }
            return response;
          };
          localStorage.setItem('videoOS.assetFolderOrder.v1.'+project.id, JSON.stringify({[project.folder]:[project.folder+'/生成图片',project.folder+'/2026-10-08',project.folder+'/生成视频',project.folder+'/2026-10-09']}));
        })();""".replace('PROJECT', json.dumps(project, ensure_ascii=False)))
        page.goto(args.base + ('/creator-assets.html?surface=library' if surface == 'library' else '/creator.html?mode=' + surface))
        page.wait_for_load_state('networkidle')
        expect(page.locator('body')).to_have_attribute('data-ready', 'true')
        expect(page.locator('.asset-title strong' if surface == 'library' else '.creator-brand strong')).to_contain_text('候选版')
        assert '候选版 1.2.4-candidate' in page.title()
        row_class = '.folder-row' if surface == 'library' else '.quick-folder-row'
        tree_id = '#folderTree' if surface == 'library' else '#quickFolderTree'
        row = lambda path: page.locator(row_class + '[data-folder-path="' + path + '"]')
        root = row(project['folder'])
        root.click(button='right')
        field = page.get_by_role('textbox', name='文件夹名称', exact=True)
        expect(field).to_be_visible()
        page.screenshot(path=str(artifacts / (surface + '-inline-create.png')), full_page=True)
        field.fill('取消目录'); field.press('Escape')
        expect(field).to_have_count(0)
        assert not requests['folder']
        root.click(button='right'); field.fill('生成图片'); field.press('Enter')
        expect(field).to_have_attribute('aria-invalid', 'true')
        field.fill('第02集'); field.press('Enter')
        expect(row('整理夹具/第02集')).to_be_visible()
        row('整理夹具/第02集').click(button='right'); field.fill('办公室'); field.press('Enter')
        expect(row('整理夹具/第02集/办公室')).to_be_visible()
        assert requests['folder'][-1]['parent'] == '整理夹具/第02集'
        # 空白右键的父位置必须为本剧根，取消不产生磁盘操作。
        page.locator(tree_id).dispatch_event('contextmenu', {'button': 2, 'clientX': 30, 'clientY': 400})
        expect(field).to_be_visible(); field.press('Escape')
        assert page.evaluate('window.__folderMenuRequests.at(-1).path') == project['folder']
        # 普通目录排序保存不改变；日期槽位仍是新在前。
        roots = page.locator(tree_id + ' > ' + row_class).all_text_contents()
        assert '全部资产' in roots[0]
        ordered = page.locator(row_class).evaluate_all('(rows)=>rows.map(row=>row.dataset.folderPath)')
        assert ordered.index('整理夹具/2026-10-09') < ordered.index('整理夹具/2026-10-08')
        if surface == 'library':
            root.locator('.folder-button').click()
            card = lambda path: page.locator('.asset-card[data-path="' + path + '"]')
        else:
            for path in ['整理夹具/生成图片', '整理夹具/生成图片/第01集', '整理夹具/生成视频', '整理夹具/生成视频/第01集']:
                node = row(path)
                if node.locator('.quick-folder-name').get_attribute('aria-expanded') == 'false': node.locator('.quick-folder-name').click()
            card = lambda path: page.locator('.asset-card-wrap[data-asset-path="' + path + '"]')
        source = '整理夹具/生成图片/第01集/母图.png'
        destination = '整理夹具/生成视频/第01集'
        target_dialog = '#moveDialog' if surface == 'library' else '#quickMoveDialog'
        source_card = card(source)
        (source_card if surface == 'library' else source_card.locator('.asset-image-card')).click(button='right')
        page.get_by_role('menuitem', name='移动到…', exact=True).click()
        expect(page.locator(target_dialog)).to_be_visible()
        target = page.locator(target_dialog + ' .move-folder-row[data-folder-path="' + destination + '"]')
        expect(target).to_have_text(destination)
        page.wait_for_timeout(320)  # 截图在打开动画结束后检查整体布局。
        page.screenshot(path=str(artifacts / (surface + '-target.png')), full_page=True)
        before = requests['tree']; target.click()
        expect(card(destination + '/母图.png')).to_be_visible()
        assert requests['move'][-1] == {'path': source, 'folder': destination}
        page.wait_for_timeout(400)
        assert requests['tree'] == before + 1, (surface, 'single reload', requests)
        # 多选复制产生独立副本，失败项保留原文件。
        paths = [destination + '/母图.png', '整理夹具/生成图片/第01集/失败.png', destination + '/已在目标.png']
        if surface == 'library':
            root.locator('.folder-button').click()
            for path in paths: card(path).locator('.asset-check').click()
        else:
            page.locator('#quickMultiSelect').click()
            for path in paths: card(path).locator('.asset-image-card').click()
        item = card(paths[0])
        (item if surface == 'library' else item.locator('.asset-image-card')).click(button='right')
        page.get_by_role('menuitem', name='复制到…（3 项）', exact=True).click()
        before = requests['tree']
        page.locator(target_dialog + ' .move-folder-row[data-folder-path="整理夹具/生成图片/第01集"]').click()
        toast = page.locator('#assetToast' if surface == 'library' else '#creatorToast')
        expect(toast).to_contain_text('成功 2，跳过 0，失败 1')
        page.wait_for_timeout(400)
        assert requests['tree'] == before + 1, (surface, 'batch reload', requests)
        assert find(paths[0]) and find('整理夹具/生成图片/第01集/母图.png')
        # 同目录比较只作用于移动；不同来源批次允许选择其中一个来源目录。
        if surface == 'library': root.locator('.folder-button').click()
        item = card(paths[0])
        (item if surface == 'library' else item.locator('.asset-image-card')).click(button='right')
        page.get_by_role('menuitem', name='移动到…（3 项）', exact=True).click()
        before = requests['tree']
        page.locator(target_dialog + ' .move-folder-row[data-folder-path="' + destination + '"]').click()
        expect(toast).to_contain_text('成功 0，跳过 2，失败 1')
        page.wait_for_timeout(400)
        assert requests['tree'] == before + 1
        # 刚才失败文件位于目标而跳过；单独移动它应报告失败且留在原处。
        if surface == 'library':
            page.locator('#clearSelection').click()
            root.locator('.folder-button').click()
        else:
            page.locator('#quickSelClear').click()
        failed_path = '整理夹具/生成图片/第01集/失败.png'
        failed_card = card(failed_path)
        (failed_card if surface == 'library' else failed_card.locator('.asset-image-card')).click(button='right')
        page.get_by_role('menuitem', name='移动到…', exact=True).click()
        page.locator(target_dialog + ' .move-folder-row[data-folder-path="' + destination + '"]').click()
        expect(toast).to_contain_text('成功 0，跳过 0，失败 1')
        assert find(failed_path)
        if surface != 'library':
            video = card(destination + '/预览.mp4').locator('.asset-image-card')
            video.click(button='right')
            assert page.evaluate('window.__floatRequests.at(-1).path') == destination + '/预览.mp4'
            menu = page.locator('.asset-context-menu').bounding_box()
            tree_bounds = page.locator(tree_id).bounding_box()
            assert menu['x'] + menu['width'] <= tree_bounds['x'] + tree_bounds['width'] + 1
            page.keyboard.press('Escape')
            page.locator('#quickMultiSelect').click()
        # 外部移动事件先更新正在打开的预览与选择，然后再刷新树。
        video_path = destination + '/预览.mp4'
        if surface == 'library':
            root.locator('.folder-button').click()
            card(video_path).locator('.asset-check').click()
            card(video_path).locator('.asset-preview-button').click()
        else:
            page.evaluate('(path)=>state.quickSelectionOrder=[path]', video_path)
            card(video_path).locator('.asset-image-card').click()
        preview_id = '#previewDialog' if surface == 'library' else '#quickPreviewDialog'
        expect(page.locator(preview_id)).to_be_visible()
        video_node = find(video_path)
        find(destination)['children'].remove(video_node)
        video_node['path'] = '整理夹具/第02集/办公室/预览改名.mp4'
        video_node['name'] = '预览改名.mp4'
        find('整理夹具/第02集/办公室')['children'].append(video_node)
        moved_event = {'projectId': project['id'], 'moves': [{'oldPath': video_path, 'path': video_node['path'], 'assetId': video_node['assetId']}]}
        page.evaluate("payload=>window.__emit('creative-assets',payload)", moved_event)
        expect(page.locator(preview_id + ' video')).to_have_attribute('src', '/api/creative-assets/file?project=organization-fixture&p=' + quote(video_node['path'], safe=''))
        selection = page.evaluate('()=>[...state.selectedPaths]' if surface == 'library' else '()=>state.quickSelectionOrder')
        assert video_node['path'] in selection and video_path not in selection
        before = requests['tree']
        page.wait_for_timeout(400)
        assert requests['tree'] == before + 1
        assert page.evaluate('()=>state.preview.path' if surface == 'library' else '()=>quickPreviewItem.path') == video_node['path']
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)
        expect(page.locator(preview_id + ' video')).to_have_count(0)
        page.screenshot(path=str(artifacts / (surface + '.png')), full_page=True)
        context.close()
        print('ORGANIZATION_UI_SURFACE_PASS', surface, json.dumps(requests, ensure_ascii=False))
    assert not errors, errors
    browser.close()
    print('ASSET_ORGANIZATION_UI_PASS: root/blank/subfolder inline creation, cancel/conflict/retry, full-path move, batch copy/skip/failure, one final reload, ordering, direct video float, SSE preview/selection remap')
