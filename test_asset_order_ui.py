"""隔离浏览器回归：旧日期排序记录不得覆盖最新在前；不触碰正式会话。"""
import argparse
import base64
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
parser.add_argument('--out', default='test-artifacts/asset-order')
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
project = {'id': 'project-date-order', 'name': '排序测试', 'folder': '排序测试', 'kind': 'script', 'categories': []}
dates = ['2026-09-10', '2026-09-11', '2026-09-18', '2026-09-28', '2026-10-07', '2026-10-08']
newest = list(reversed(dates))
png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')

def media_folder(category, source, kind, extension):
    parent = project['folder'] + '/' + category + '/' + source
    days = []
    for date in dates:
        folder = parent + '/' + date
        items = [{'kind': 'file', 'type': kind, 'name': '生成-' + sequence + extension,
                  'path': folder + '/生成-' + sequence + extension, 'size': 128, 'sizeText': '128 B', 'ext': extension,
                  'mtime': date + ('T08:00:00Z' if sequence == '001' else 'T09:00:00Z')}
                 for sequence in ['001', '002']]
        days.append({'kind': 'folder', 'name': date, 'path': folder, 'fileCount': 2, 'children': items})
    return {'kind': 'folder', 'name': category, 'path': project['folder'] + '/' + category, 'fileCount': 12,
            'children': [{'kind': 'folder', 'name': source, 'path': parent, 'fileCount': 12, 'children': days}]}

video = media_folder('生成视频', '核绘', 'video', '.mp4')
image = media_folder('生成图片', 'GPT', 'image', '.png')
documents = media_folder('浏览器下载', 'GPT', 'document', '.txt')
tree = {'available': True, 'project': project, 'rootName': project['name'],
        'stats': {'folders': 26, 'files': 36, 'video': 12, 'image': 12, 'audio': 0, 'document': 12, 'sizeText': '4.5 KB'},
        'tree': {'kind': 'folder', 'name': project['name'], 'path': project['folder'], 'fileCount': 36,
                 'children': [{'kind': 'folder', 'name': name, 'path': project['folder'] + '/' + name,
                               'fileCount': 0, 'children': []} for name in ['场景资产', '人物资产']] + [video, image, documents]}}
saved = {project['folder']: [project['folder'] + '/' + name for name in ['人物资产', '场景资产', '生成视频', '生成图片']]}
for category in [video, image]:
    parent = category['children'][0]['path']
    saved[parent] = [parent + '/' + date for date in dates[:4]]
key = 'videoOS.assetFolderOrder.v1.' + project['id']
projects = {'activeProjectId': project['id'], 'projects': [project], 'categories': []}

def mock_api(route):
    endpoint = urlparse(route.request.url).path
    if endpoint == '/api/events':
        route.fulfill(status=200, content_type='text/event-stream', body='')
        return
    if endpoint == '/api/creative-assets/file':
        route.fulfill(status=200, content_type='image/png' if '.png' in route.request.url else 'video/mp4',
                      body=png if '.png' in route.request.url else b'')
        return
    data = {'ok': True}
    if endpoint == '/api/creative-projects': data = projects
    elif endpoint == '/api/creative-assets': data = tree
    elif endpoint == '/api/production': data = {'available': False, 'inbox': [], 'stats': {}}
    elif endpoint == '/api/knowledge': data = {'sections': []}
    elif endpoint == '/api/scan': data = {'counts': {'image': 12, 'video': 12, 'audio': 0, 'docs': 0}, 'files': [], 'docs': [], 'scannedAt': '2026-10-08T10:00:00Z', 'mediaSources': []}
    elif endpoint == '/api/obsidian/tree': data = {'available': False}
    route.fulfill(status=200, content_type='application/json', body=json.dumps(data, ensure_ascii=False))

with sync_playwright() as p:
    chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = p.chromium.launch(headless=True, executable_path=chrome if os.path.isfile(chrome) else None)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, timezone_id='Asia/Taipei')
    context.route('**/api/**', mock_api)
    context.add_init_script("localStorage.setItem(KEY, VALUE);".replace('KEY', json.dumps(key)).replace('VALUE', json.dumps(json.dumps(saved))))
    context.add_init_script("""(() => {
      const OriginalEventSource = window.EventSource;
      window.__sortingEvents = [];
      window.EventSource = class extends OriginalEventSource {
        constructor(...args) { super(...args); window.__sortingEvents.push(this); }
      };
    })();""")
    errors = []
    creator = context.new_page()
    creator.on('pageerror', lambda error: errors.append(str(error)))
    creator.add_init_script("""(() => {
      const project = PROJECT;
      const service = {id:'gpt', label:'GPT', imageLabel:'GPT 图片', videoLabel:'GPT 提示词', url:'about:blank'};
      const browser = mode => ({mode, serviceId:'gpt', title:'测试', url:'about:blank', displayUrl:'about:blank', tabs:[], activeTabId:'', loading:false});
      const api = {
        getConfig: async () => ({project, services:[service], modeServices:{image:['gpt'], video:['gpt']}, defaults:{image:'gpt',video:'gpt'}, paths:{creativeAssetAvailable:true}, browser:browser('image'), testMode:true}),
        getDownloads: async () => [], setMode: async mode => browser(mode),
        setAssetPanel: async patch => ({...patch, creativeAssetAvailable:true}),
      };
      window.creatorAPI = new Proxy(api, {get(target, key) {
        if (key in target) return target[key];
        if (String(key).startsWith('on')) return () => () => {};
        return async () => undefined;
      }});
    })();""".replace('PROJECT', json.dumps(project, ensure_ascii=False)))
    creator.goto(args.base + '/creator.html?mode=image&project=' + project['id'])
    creator.wait_for_load_state('networkidle')
    expect(creator.locator('body')).to_have_attribute('data-ready', 'true')
    print('SORT_UI_DOM', creator.locator('#quickFolderTree .quick-folder-name').all_text_contents())

    def quick_dates(parent):
        return creator.locator('#quickFolderTree .quick-folder-row').evaluate_all(
            '(rows, parent) => rows.filter(row => row.dataset.folderPath.startsWith(parent + "/") && row.dataset.folderPath.slice(parent.length + 1).indexOf("/") < 0).map(row => row.dataset.folderPath.split("/").pop())', parent)

    for mode in ['image', 'video']:
        creator.get_by_role('button', name='图片模式' if mode == 'image' else '视频模式', exact=True).click()
        expect(creator.locator('body')).to_have_attribute('data-mode', mode)
        for category in [video, image]:
            assert quick_dates(category['children'][0]['path']) == newest
        assert creator.locator('.quick-folder-row[data-folder-path$="/2026-10-08"] .quick-folder-grip').count() == 0
    ordinary = creator.locator('.quick-folder-row[data-folder-path="排序测试/场景资产"] .quick-folder-grip')
    ordinary.scroll_into_view_if_needed()
    ordinary.press('Alt+ArrowUp')
    root_order = creator.locator('#quickFolderTree .quick-folder-row').evaluate_all(
        '(rows) => rows.filter(row => row.dataset.folderPath.split("/").length === 2).map(row => row.dataset.folderPath.split("/").pop())')
    assert root_order[:2] == ['场景资产', '人物资产'], root_order
    for category in [video, image]: assert quick_dates(category['children'][0]['path']) == newest
    # 保存的旧日期记录仍在，普通分类换位不会清空其他父目录的数据。
    retained = json.loads(creator.evaluate('(key) => localStorage.getItem(key)', key))
    assert retained[video['children'][0]['path']] == saved[video['children'][0]['path']]
    # 同一天的最新下载在前，卡片仍可拖动。
    parent = video['children'][0]['path'] + '/2026-10-08'
    row = creator.locator('.quick-folder-row[data-folder-path="' + parent + '"]')
    quick_cards = row.locator('xpath=following-sibling::*[1]').locator('.asset-image-card')
    quick_paths = quick_cards.evaluate_all('(cards) => cards.map(card => card.title.split("\\n")[0])')
    assert quick_paths == ['生成-002.mp4', '生成-001.mp4'], quick_paths
    assert quick_cards.count() == 2
    assert quick_cards.evaluate_all('(cards) => cards.every(card => card.draggable)')
    creator.locator('#browserDownloadNav button[title="打开文件夹「GPT」"]').click()
    download_dates = creator.locator('#browserDownloadNav .browser-download-folder[title]').all_text_contents()
    assert [label.split(' · ')[0].replace('📁 ', '') for label in download_dates] == newest
    creator.locator('#browserDownloadNav button[title="打开文件夹「2026-10-08」"]').click()
    document_names = creator.locator('#browserDownloadGrid .asset-image-card').evaluate_all(
        '(cards) => cards.map(card => card.title.split("\\n")[0])')
    assert document_names == ['生成-002.txt', '生成-001.txt'], document_names

    library = context.new_page()
    library.on('pageerror', lambda error: errors.append(str(error)))
    library.goto(args.base + '/creator-assets.html?surface=library')
    library.wait_for_load_state('networkidle')
    expect(library.locator('body')).to_have_attribute('data-ready', 'true')
    print('LIBRARY_SORT_DOM', library.locator('#folderTree .folder-name').all_text_contents())
    for category in [video, image]:
        parent = category['children'][0]['path']
        actual = library.locator('#folderTree .folder-row').evaluate_all(
            '(rows, parent) => rows.filter(row => row.dataset.folderPath.startsWith(parent + "/") && row.dataset.folderPath.slice(parent.length + 1).indexOf("/") < 0).map(row => row.dataset.folderPath.split("/").pop())', parent)
        assert actual == newest, actual
    assert library.locator('.folder-row[data-folder-path$="/2026-10-08"] .folder-order-grip').count() == 0
    for sort in ['recent', 'folder']:
        library.get_by_label('资产排序', exact=True).select_option(sort)
        names = library.evaluate('() => visibleAssets().filter(item => item.type === "video").map(item => item.path)')
        assert [name.split('/')[-2] for name in names] == [date for date in newest for _ in range(2)]
        assert [name.split('/')[-1] for name in names[:2]] == ['生成-002.mp4', '生成-001.mp4']
    newest_row = library.locator('.folder-row[data-folder-path="排序测试/生成视频/核绘/2026-10-08"]')
    assert newest_row.locator('xpath=following-sibling::*[1]').locator('.folder-file').all_text_contents() == ['生成-002.mp4', '生成-001.mp4']
    assert newest_row.locator('xpath=following-sibling::*[1]').locator('.folder-file[draggable="true"]').count() == 2

    main = context.new_page()
    main.on('pageerror', lambda error: errors.append(str(error)))
    main.goto(args.base + '/')
    main.wait_for_load_state('networkidle')
    test_files = [item for folder in video['children'][0]['children'] for item in folder['children']]
    for sort in ['newest', 'oldest', 'folder']:
        actual = main.evaluate('({files, sort}) => sortAssets(files, sort).map(item => item.path.split("/").slice(-2, -1)[0])', {'files': test_files, 'sort': sort})
        assert actual == [date for date in newest for _ in range(2)], actual
    # 模拟运行中的新下载：接口新增日期后，真实的事件监听和刷新路径应立即置顶。
    library.get_by_label('资产排序', exact=True).select_option('recent')
    parent = video['children'][0]['path']
    new_date = '2026-10-09'
    new_path = parent + '/' + new_date + '/新下载.mp4'
    video['children'][0]['children'].append({'kind': 'folder', 'name': new_date, 'path': parent + '/' + new_date,
        'fileCount': 1, 'children': [{'kind': 'file', 'name': '新下载.mp4', 'path': new_path, 'type': 'video',
                                    'mtime': new_date + 'T08:00:00Z', 'size': 128, 'sizeText': '128 B', 'ext': '.mp4'}]})
    tree['stats']['files'] += 1
    tree['stats']['video'] += 1
    for folder in [tree['tree'], video, video['children'][0]]: folder['fileCount'] += 1
    for target in [creator, library]:
        target.evaluate('() => window.__sortingEvents.forEach(source => source.dispatchEvent(new Event("creative-assets")))')
    creator.wait_for_function('(parent) => [...document.querySelectorAll("#quickFolderTree .quick-folder-row")].filter(row => row.dataset.folderPath.startsWith(parent + "/"))[0]?.dataset.folderPath === parent + "/2026-10-09"', arg=parent)
    assert quick_dates(parent) == [new_date] + newest
    expect(library.locator('#assetGrid .asset-card')).to_have_count(37)
    assert library.locator('#assetGrid .asset-card').first.get_attribute('data-path') == new_path
    assert not errors, errors
    report = {'passed': True, 'dateOrder': newest,
              'checks': ['旧缓存不覆盖日期排序', '未保存的新日期自动置顶', '图片与视频模式', '普通分类键盘换位保留', '完整资产树和网格', '按文件夹日期倒序', '同日新文件置顶', '卡片拖动属性保留', '浏览器下载文件夹与文件', '媒体列表', '运行中新下载自动刷新置顶'],
              'scope': '隔离源代码页面，creatorAPI 测试适配器；不代表已安装 App 已更新'}
    (out / 'ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('ASSET_ORDER_UI_PASS', json.dumps(report, ensure_ascii=False))
