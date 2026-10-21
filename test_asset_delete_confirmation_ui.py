#!/usr/bin/env python3
"""Full asset library single/batch confirmation routing regression.

Uses the existing isolated HTTP fixture and mock native bridge. No production
port, App profile, real asset directory, or system Trash is touched. Native
five-minute authorization is covered by the backend tests, not this UI mock.
"""

import argparse
import hashlib
import json
from pathlib import Path
import threading
import traceback
from http.server import ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright

import test_asset_batch_delete_ui as fixture_ui


ROOT = Path(__file__).resolve().parent


def trigger_single(page, path):
    expected = page.evaluate("__bulk.calls.length") + 1
    card = page.locator('#assetGrid .asset-card[data-path="' + path + '"]')
    card.hover()
    card.locator('.asset-delete-button').click()
    page.wait_for_function('n => __bulk.calls.length === n', arg=expected)


def run_case(page, fixture, case):
    tokens = fixture.paths('A')
    assert page.locator('#selectionBar').is_visible(), 'Batch operations must be discoverable before selecting'
    assert page.locator('#selectVisible').is_visible() and page.locator('#selectVisible').is_enabled()
    assert page.locator('#batchDelete').is_disabled()
    assert page.locator('#assetGrid .asset-check').count() == 3
    assert page.locator('#assetGrid .asset-check').first.evaluate('e => getComputedStyle(e).opacity') == '1'

    if case == 'collapsed_toolbar_restore':
        page.set_viewport_size({'width': 720, 'height': 860})
        page.locator('[data-filter="image"]').click()
        page.locator('#assetCollapse').click()
        page.wait_for_function("document.querySelector('#assetGrid').getBoundingClientRect().height < 2")
        page.wait_for_timeout(300)
        collapsed = page.evaluate("() => ({headingBottom: document.querySelector('.library-heading').getBoundingClientRect().bottom, paneBottom: document.querySelector('.library-pane').getBoundingClientRect().bottom, barDisplay: getComputedStyle(document.querySelector('#selectionBar')).display})")
        assert collapsed['barDisplay'] == 'none', collapsed
        assert abs(collapsed['headingBottom'] - collapsed['paneBottom']) <= 2, collapsed
        page.locator('#assetCollapse').click()
        page.wait_for_function("document.querySelector('#assetGrid').getBoundingClientRect().height > 100")
        assert page.locator('#selectionBar').is_visible() and page.locator('#selectVisible').is_visible()
        assert fixture_ui.snapshot(page, 'library')['selected'] == []
        return {'collapsed': collapsed, 'expandedToolbarVisible': True, 'after': fixture_ui.snapshot(page, 'library')}

    if case == 'select_visible_replaces_other_folder':
        fixture_ui.choose(page, 'library', [tokens[0]])
        other = fixture.add('A', '场景1.png', '场景资产')
        page.evaluate('() => loadLibrary()')
        page.locator('.folder-button[data-folder-path="隔离剧本A/场景资产"]').click()
        assert fixture_ui.snapshot(page, 'library')['selected'] == [tokens[0]]
        assert page.locator('#assetGrid .asset-card').count() == 1
        page.locator('#selectVisible').click()
        assert fixture_ui.snapshot(page, 'library')['selected'] == [other]
        fixture_ui.trigger(page, 'library')
        assert fixture_ui.snapshot(page, 'library')['calls'][0]['paths'] == [other]
        fixture_ui.complete(page, 'library', fixture_ui.reply([other], cancelled=True))
        return {'after': fixture_ui.snapshot(page, 'library')}

    if case == 'discoverable_batch':
        page.locator('#selectVisible').click()
        selected = fixture_ui.snapshot(page, 'library')['selected']
        assert set(selected) == set(tokens)
        assert page.locator('#assetGrid .asset-check[aria-pressed="true"]').count() == 3
        fixture_ui.trigger(page, 'library')
        fixture_ui.complete(page, 'library', fixture_ui.reply(tokens, cancelled=True))
        final = fixture_ui.snapshot(page, 'library')
        assert final['selected'] == selected
    else:
        fixture_ui.choose(page, 'library', tokens[:2])
        before = fixture_ui.snapshot(page, 'library')
        target = tokens[0] if case in ('selected_success', 'failed', 'stale_get', 'project_switch') else tokens[2]
        if case == 'missing_api':
            page.evaluate('__bulk.hasAPI=false')
            page.locator('#assetGrid .asset-card[data-path="' + target + '"]').hover()
            page.locator('#assetGrid .asset-card[data-path="' + target + '"] .asset-delete-button').click()
            final = fixture_ui.snapshot(page, 'library')
            assert final['calls'] == [] and final['selected'] == tokens[:2]
            assert '桌面' in final['toast']
            return {'before': before, 'after': final}
        held = fixture_ui.begin_old_read(page, fixture, 'library') if case == 'stale_get' else None
        trigger_single(page, target)
        pending = fixture_ui.snapshot(page, 'library')
        assert pending['calls'] == [{'projectId': fixture_ui.PROJECTS['A']['id'], 'paths': [target]}], pending
        assert pending['selected'] == tokens[:2]
        assert page.locator('#selectVisible').is_disabled()
        assert page.locator('#assetGrid .asset-delete-button').first.is_disabled()
        if case == 'cancel':
            fixture_ui.complete(page, 'library', fixture_ui.reply([target], cancelled=True))
            final = fixture_ui.snapshot(page, 'library')
            assert final['selected'] == tokens[:2] and final['assets'] == before['assets'], final
        elif case == 'failed':
            fixture_ui.complete(page, 'library', fixture_ui.reply([target], failed=[{'path': target, 'error': '模拟无法删除'}]))
            final = fixture_ui.snapshot(page, 'library')
            assert final['selected'] == tokens[:2] and target in final['assets'], final
            assert '失败' in final['toast']
        elif case == 'project_switch':
            fixture_ui.change_project(page, 'library', 'B')
            new_token = fixture.paths('B')[2]
            page.evaluate('p => {state.selectedPaths=new Set([p]);updateSelectionBar();}', new_token)
            fixture_ui.complete(page, 'library', fixture_ui.reply([target], deleted=[target]))
            final = fixture_ui.snapshot(page, 'library')
            assert final['project'] == fixture_ui.PROJECTS['B']['id'] and final['selected'] == [new_token]
            assert '废纸篓' not in final['toast']
        else:
            fixture.remove('A', [target])
            if held:
                fixture.fail_reads = 1
            fixture_ui.complete(page, 'library', fixture_ui.reply([target], deleted=[target]))
            final = fixture_ui.snapshot(page, 'library')
            assert final['selected'] == [p for p in tokens[:2] if p != target], final
            assert target not in final['assets'] and len(final['assets']) == 2, final
            if held:
                fixture_ui.release_old_read(page, held, 'library')
                final = fixture_ui.snapshot(page, 'library')
                assert target not in final['assets'] and final['selected'] == [tokens[1]], final
                assert '刷新' in final['toast']
    assert not final['rendererConfirms'] and not final['singleCalls'] and not final['downloadCalls'], final
    assert len(final['calls']) == 1, final
    return {'after': final}


def run_quick_case(page, fixture, case):
    tokens = fixture.paths('A')
    fixture_ui.open_folders(page, 'quick')
    assert page.locator('#quickMultiSelect').is_visible()
    assert page.locator('#quickMultiSelect').inner_text() == '批量选择'
    if case in ('discoverable_batch', 'partial'):
        page.locator('#quickMultiSelect').click()
        assert page.locator('#quickTools').is_visible() and page.locator('#quickSelAll').is_visible()
        assert page.locator('#quickSelDelete').is_disabled()
        page.locator('#quickSelAll').click()
        selected = fixture_ui.snapshot(page, 'quick')['selected']
        assert set(selected) == set(tokens), selected
        assert page.locator('.asset-image-card[aria-pressed="true"]').count() == 3
        fixture_ui.trigger(page, 'quick')
        if case == 'partial':
            fixture.remove('A', [selected[0]])
            fixture_ui.complete(page, 'quick', fixture_ui.reply(selected, deleted=[selected[0]], failed=[{'path': selected[1], 'error': '模拟失败'}], cancelled=True))
            final = fixture_ui.snapshot(page, 'quick')
            assert final['selected'] == selected[1:] and selected[0] not in final['assets']
        else:
            fixture_ui.complete(page, 'quick', fixture_ui.reply(selected, cancelled=True))
            final = fixture_ui.snapshot(page, 'quick')
            assert final['selected'] == selected
    else:
        # Model an existing selection retained in normal mode; the visible
        # single-card delete must not substitute that selection into its payload.
        page.evaluate('paths=>{state.quickSelectionOrder=paths;updateQuickSelectionUI();}', tokens[:2])
        target = tokens[2]
        card = page.locator('.asset-card-wrap[data-asset-path="' + target + '"]')
        card.hover()
        card.locator('.asset-quick-delete').click()
        page.wait_for_function('__bulk.calls.length === 1')
        assert fixture_ui.snapshot(page, 'quick')['calls'][0]['paths'] == [target]
        if case == 'cancel':
            fixture_ui.complete(page, 'quick', fixture_ui.reply([target], cancelled=True))
            final = fixture_ui.snapshot(page, 'quick')
            assert final['selected'] == tokens[:2] and target in final['assets']
        else:
            fixture.remove('A', [target])
            fixture_ui.complete(page, 'quick', fixture_ui.reply([target], deleted=[target]))
            final = fixture_ui.snapshot(page, 'quick')
            assert final['selected'] == tokens[:2] and target not in final['assets']
    assert not final['rendererConfirms'] and not final['singleCalls'] and not final['downloadCalls'], final
    return {'after': final}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', default='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    parser.add_argument('--evidence', default=str(ROOT / 'test-artifacts/asset-delete-confirmation-ui-20261019'))
    parser.add_argument('--cases', help='Optional comma-separated surface:case names')
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    if not evidence.is_relative_to(ROOT / 'test-artifacts'):
        raise RuntimeError('Evidence must remain under test-artifacts')
    evidence.mkdir(parents=True, exist_ok=True)
    sources = ['creator-assets.js', 'creator-assets.html', 'creator-assets.css', 'creator.js', 'creator.html', 'creator.css', 'test_asset_batch_delete_ui.py']
    hashes = lambda: {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in sources}
    receipt = {'scope': 'full-library-native-bridge-routing-mock', 'formalAppTouched': False,
               'formalProfileOrDataTouched': False, 'realTrashOperationPerformed': False,
               'sourceHashes': hashes(), 'cases': []}
    cases = [('library', name) for name in ('discoverable_batch', 'collapsed_toolbar_restore', 'select_visible_replaces_other_folder', 'cancel', 'unselected_success', 'selected_success', 'failed', 'stale_get', 'project_switch', 'missing_api')]
    cases += [('quick', name) for name in ('discoverable_batch', 'partial', 'cancel', 'unselected_success')]
    if args.cases:
        requested = set(args.cases.split(','))
        cases = [item for item in cases if ':'.join(item) in requested]
        if len(cases) != len(requested):
            raise RuntimeError('Unknown case selection')
    fixture = fixture_ui.Fixture()
    fixture_ui.PROJECTS['A']['categories'].append({'id': 'scenes', 'label': '场景资产', 'path': '隔离剧本A/场景资产'})
    server = ThreadingHTTPServer(('127.0.0.1', 0), fixture_ui.handler_for(fixture))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = 'http://127.0.0.1:' + str(server.server_address[1])
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=args.browser)
            try:
                for surface, case in cases:
                    fixture.reset()
                    context = browser.new_context(viewport={'width': 1500, 'height': 1000})
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.set_default_timeout(6000)
                    report = {'surface': surface, 'case': case, 'status': 'running'}
                    try:
                        init = fixture_ui.INIT_JS.replace('__PROJECTS__', json.dumps(fixture_ui.PROJECTS, ensure_ascii=False)).replace('__ORIGIN__', json.dumps(origin))
                        page.add_init_script(init)
                        # A valid empty archive is the normal control, rather
                        # than the shared fixture's generic API fallback, which
                        # intentionally triggers an unrelated visible error note.
                        if case == 'collapsed_toolbar_restore':
                            page.route('**/api/download-episodes?*', lambda route: route.fulfill(json={
                                'projectId': parse_qs(urlparse(route.request.url).query).get('project', [''])[0], 'states': []}))
                        page.goto(origin + ('/creator-assets.html?surface=library' if surface == 'library' else '/creator.html?mode=image'), wait_until='networkidle')
                        page.wait_for_function("document.body.dataset.ready === 'true'")
                        report.update(run_case(page, fixture, case) if surface == 'library' else run_quick_case(page, fixture, case))
                        assert not errors, errors
                        assert not fixture.writes, fixture.writes
                        report['status'] = 'passed'
                        print('ASSET_DELETE_CONFIRMATION_UI_PASS', surface, case, flush=True)
                    except Exception as error:
                        report.update(status='failed', error=str(error), stack=traceback.format_exc())
                        print('ASSET_DELETE_CONFIRMATION_UI_FAILED', surface, case, str(error)[:500], flush=True)
                    finally:
                        fixture.release_reads()
                        report['pageErrors'] = errors
                        report['forbiddenWrites'] = list(fixture.writes)
                        receipt['cases'].append(report)
                        context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        receipt['fixtureCleaned'] = not thread.is_alive()
        receipt['sourceHashesAtEnd'] = hashes()
        receipt['ok'] = len(receipt['cases']) == len(cases) and all(item['status'] == 'passed' for item in receipt['cases']) and receipt['fixtureCleaned'] and receipt['sourceHashes'] == receipt['sourceHashesAtEnd']
        (evidence / 'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print('ASSET_DELETE_CONFIRMATION_UI_RESULT', json.dumps({'ok': receipt['ok'], 'cases': len(receipt['cases'])}), str(evidence), flush=True)
    if not receipt['ok']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
