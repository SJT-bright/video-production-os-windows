"""固定模板迁移隔离 UI 验收：右键入口、两模式追加、不覆盖和刷新保留。"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('base')
args = parser.parse_args()
out = Path('test-artifacts/prompt-template-migration').resolve()
out.mkdir(parents=True, exist_ok=True)
projects = [dict(id='project-' + suffix, name=name, folder=name, available=True, kind='script', categories=[])
            for suffix, name in [('a', '来源剧本'), ('b', '目标剧本'), ('c', '全新剧本')]]
projects.append(dict(id='project-unavailable', name='不可用剧本', folder='不可用剧本', available=False))
key = 'videoOS.creator.project.v2.'

def mock_api(route):
    endpoint = urlparse(route.request.url).path
    if endpoint == '/api/events':
        route.fulfill(status=200, content_type='text/event-stream', body='')
        return
    data = {'available': False, 'ok': True}
    if endpoint == '/api/creative-projects': data = {'projects': projects}
    if endpoint == '/api/production': data = {'available': False, 'inbox': [], 'stats': {}}
    if endpoint == '/api/creative-assets':
        requested = parse_qs(urlparse(route.request.url).query).get('project', ['project-a'])[0]
        project = next(item for item in projects if item['id'] == requested)
        data = {'available': True, 'project': project, 'stats': {'files': 0, 'image': 0, 'video': 0, 'audio': 0},
                'tree': {'kind': 'folder', 'name': project['name'], 'path': project['folder'], 'children': []}}
    route.fulfill(content_type='application/json', body=json.dumps(data, ensure_ascii=False))

initial = {
    'project-a': {'version': 2, 'promptTemplatesVersion': 3, 'promptTemplates': {
        'image': [{'id': 'a1', 'title': '通用', 'body': '来源图片提示词'}],
        'video': [{'id': 'a2', 'title': '对白', 'body': '来源视频提示词'}]},
        'prompts': {'image': '来源草稿', 'video': ''}, 'scripts': {'groups': []}},
    'project-b': {'version': 2, 'promptTemplatesVersion': 3, 'promptTemplates': {
        'image': [{'id': 'b1', 'title': '通用', 'body': '目标原模板'}], 'video': []},
        'prompts': {'image': '目标原草稿', 'video': ''}, 'scripts': {'groups': []}, 'extra': 'keep'},
}

with sync_playwright() as p:
    chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    browser = p.chromium.launch(headless=True, executable_path=chrome if os.path.exists(chrome) else None)
    context = browser.new_context(viewport={'width': 1440, 'height': 940})
    context.route('**/api/**', mock_api)
    context.add_init_script("""(() => {
      const projects = PROJECTS, initial = INITIAL;
      if (!localStorage.getItem('__promptTestSeeded')) {
        Object.entries(initial).forEach(([id, saved]) => localStorage.setItem(PREFIX + id, JSON.stringify(saved)));
        localStorage.setItem('__promptTestSeeded', '1'); localStorage.setItem('__promptCurrent', 'project-a');
      }
      let changed, modeChanged;
      const current = () => projects.find(item => item.id === localStorage.getItem('__promptCurrent'));
      const browser = mode => ({mode, serviceId:'gpt', tabs:[], activeTabId:'', loading:false});
      window.__migrationCalls = []; window.__nextTarget = 'project-b'; window.__nativeShield = [];
      const api = {
        showWorkspaceMenu: undefined,
        getConfig: async () => { if (window.__configDelay) await new Promise(resolve => setTimeout(resolve, window.__configDelay));
          return {project:current(), services:[{id:'gpt',label:'GPT',imageLabel:'GPT 图片',videoLabel:'GPT 提示词',url:'about:blank'}],
          modeServices:{image:['gpt'],video:['gpt']}, defaults:{image:'gpt',video:'gpt'}, paths:{creativeAssetAvailable:true}, browser:browser('image'),testMode:true}; },
        selectProject: async ({projectId, mode}) => { localStorage.setItem('__promptCurrent', projectId); const project = current();
          changed?.(project); modeChanged?.(mode || 'image'); return {project}; },
        onProjectChanged: handler => { changed = handler; return () => {}; },
        onSetMode: handler => { modeChanged = handler; return () => {}; },
        showProjectTemplateMenu: async payload => { window.__migrationCalls.push(payload);
          const target = projects.find(item => item.id === window.__nextTarget); return target ? {targetProjectId:target.id,targetName:target.name} : {cancelled:true}; },
        setPlatformViewHidden: async hidden => { window.__nativeShield.push(hidden); },
        setAssetPanel: async patch => ({...patch, creativeAssetAvailable:false}),
        getDownloads: async () => [], setMode: async mode => browser(mode),
      };
      window.creatorAPI = new Proxy(api, {get(target, field) { if (field in target) return target[field];
        if (String(field).startsWith('on')) return () => () => {}; return async () => undefined; }});
    })();""".replace('PROJECTS', json.dumps(projects, ensure_ascii=False)).replace('INITIAL', json.dumps(initial, ensure_ascii=False)).replace('PREFIX', json.dumps(key)))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(args.base + '/creator.html?mode=image&project=project-a')
    page.wait_for_load_state('networkidle')
    expect(page.locator('body')).to_have_attribute('data-ready', 'true')
    read = lambda id: json.loads(page.evaluate('(key) => localStorage.getItem(key)', key + id))
    source_before = read('project-a')['promptTemplates']
    header_height = page.locator('.creator-header').bounding_box()['height']
    page.locator('#currentProject').click()
    expect(page.locator('#projectPopover')).to_be_visible()
    assert page.locator('.creator-header').bounding_box()['height'] == header_height
    assert page.locator('.project-menu-item').count() == 4
    expect(page.locator('[data-project-id="project-unavailable"]')).to_be_disabled()
    page.screenshot(path=str(out / 'project-menu.png'))
    page.locator('[data-project-id="project-a"]').click(button='right')
    expect(page.locator('#creatorToast')).to_contain_text('已新增到「目标剧本」')
    assert read('project-a')['promptTemplates'] == source_before
    target = read('project-b')
    assert [item['body'] for item in target['promptTemplates']['image']] == ['目标原模板', '来源图片提示词']
    assert target['promptTemplates']['image'][1]['title'] == '通用（2）'
    assert len(target['promptTemplates']['video']) == 1
    assert target['prompts']['image'] == '目标原草稿' and target['extra'] == 'keep'
    assert page.evaluate('window.__migrationCalls[0].counts') == {'image': 1, 'video': 1}
    page.locator('#currentProject').click(button='right')
    expect(page.locator('#creatorToast')).to_contain_text('无需重复添加')
    assert len(read('project-b')['promptTemplates']['image']) == 2
    page.evaluate('window.__nextTarget = ""')
    target_before_cancel = read('project-b')
    page.locator('#currentProject').click(button='right')
    assert read('project-b') == target_before_cancel
    page.evaluate('window.__configDelay = 350')
    page.locator('#currentProject').click()
    page.locator('[data-project-id="project-b"]').click()
    expect(page.locator('#currentProject')).to_contain_text('目标剧本')
    expect(page.locator('#promptTemplateList .saved-template-item')).to_have_count(2)
    expect(page.locator('#promptEditor')).to_have_value('目标原草稿')
    assert read('project-b')['promptTemplates'] == target_before_cancel['promptTemplates'], '并行模式通知不能清空目标模板'
    page.get_by_role('button', name='视频模式', exact=True).click()
    expect(page.locator('#promptTemplateList .saved-template-item')).to_have_count(1)
    page.get_by_role('button', name='图片模式', exact=True).click()
    page.reload(); page.wait_for_load_state('networkidle')
    expect(page.locator('#promptTemplateList .saved-template-item')).to_have_count(2)
    page.locator('#currentProject').click()
    page.locator('[data-project-id="project-c"]').click()
    expect(page.locator('#currentProject')).to_contain_text('全新剧本')
    expect(page.locator('#promptTemplateList .saved-template-item')).to_have_count(0)
    page.evaluate('window.__nextTarget = "project-c"')
    page.locator('#currentProject').click()
    page.locator('[data-project-id="project-b"]').click(button='right')
    expect(page.locator('#creatorToast')).to_contain_text('已新增到「全新剧本」')
    assert page.evaluate('window.__migrationCalls.at(-1).sourceProjectId') == 'project-b', '右键非当前剧本不能误用当前剧本'
    assert len(read('project-c')['promptTemplates']['image']) == 2
    assert len(read('project-c')['promptTemplates']['video']) == 1
    expect(page.locator('#promptTemplateList .saved-template-item')).to_have_count(2)
    page.locator('#currentProject').click()
    page.locator('#projectPopover').press('Escape')
    expect(page.locator('#projectPopover')).to_be_hidden()
    assert page.evaluate('window.__nativeShield.at(-1)') is False
    page.set_viewport_size({'width': 750, 'height': 640})
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    page.locator('#currentProject').click()
    expect(page.locator('#projectPopover')).to_be_visible()
    box = page.locator('#projectPopover').bounding_box()
    assert box['x'] >= 0 and box['x'] + box['width'] <= 750
    page.screenshot(path=str(out / 'narrow-project-menu.png'))
    assert not errors, errors
    report = {'passed': True, 'appendBothModes': True, 'sourcePreserved': True, 'targetPreserved': True,
              'repeatAndCancel': True, 'modeAndProjectSwitch': True, 'reloadRetained': True, 'noHeaderGrowth': True,
              'rightClickNonActiveProject': True, 'newProjectEmpty': True, 'narrowWidth': True, 'errors': errors}
    report['delayedProjectLoadKeepsTarget'] = True
    (out / 'ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('PROMPT_TEMPLATE_MIGRATION_UI_PASS', json.dumps(report, ensure_ascii=False))
    context.close(); browser.close()
