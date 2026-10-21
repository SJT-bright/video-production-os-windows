#!/usr/bin/env python3
"""Independent full-page bulk-delete UI verification; all deletion bridges are mocks.

Run with the available interpreter and installed Chromium/Chrome. This test owns
an ephemeral 127.0.0.1 fixture server and a fresh browser context per case. It does
not connect to port 3750, run server.js, read App profiles, or trash any file.
"""

import argparse
import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
PROJECTS = {
    key: {"id": f"bulk-ui-{key}", "name": f"隔离剧本{key}", "folder": f"隔离剧本{key}", "kind": "script",
          "categories": [{"id": "characters", "label": "人物资产", "path": f"隔离剧本{key}/人物资产"},
                         {"id": "browser-downloads", "label": "浏览器下载", "path": f"隔离剧本{key}/浏览器下载"}]}
    for key in ("A", "B")
}


class Fixture:
    def __init__(self):
        self.lock = threading.RLock()
        self.reset()

    def reset(self):
        with self.lock:
            for held in getattr(self, "held_reads", []):
                held["release"].set()
            self.files = {key: [self.file(key, f"人物{i}.png") for i in (1, 2, 3)] for key in PROJECTS}
            self.reads = []
            self.writes = []
            self.fail_reads = 0
            self.held_reads = []
            self.hold_queue = []

    def hold_next_read(self):
        with self.lock:
            held = {"taken": threading.Event(), "release": threading.Event(), "finished": threading.Event()}
            self.held_reads.append(held)
            self.hold_queue.append(held)
            return held

    def release_reads(self):
        for held in self.held_reads:
            held["release"].set()
        for held in self.held_reads:
            if held["taken"].is_set():
                held["finished"].wait(timeout=2)

    @staticmethod
    def file(key, name, folder="人物资产", kind="image"):
        return {"kind": "file", "type": kind, "name": name, "path": f"隔离剧本{key}/{folder}/{name}",
                "ext": Path(name).suffix, "size": len(PNG), "sizeText": "fixture",
                "mtime": "2026-10-14T00:00:00Z"}

    def paths(self, key):
        with self.lock:
            return [item["path"] for item in self.files[key] if item["type"] == "image"]

    def remove(self, key, tokens):
        with self.lock:
            self.files[key] = [item for item in self.files[key] if item["path"] not in set(tokens)]

    def add(self, key, name="新事件.png", folder="人物资产", kind="image"):
        with self.lock:
            item = self.file(key, name, folder, kind)
            self.files[key].append(item)
            return item["path"]

    def tree(self, key):
        with self.lock:
            project = PROJECTS[key]
            files = [dict(item) for item in self.files[key]]
            folders = []
            for category in project["categories"]:
                entries = [item for item in files if item["path"].startswith(category["path"] + "/")]
                folders.append({"kind": "folder", "name": category["label"], "path": category["path"],
                                "fileCount": len(entries), "children": entries})
            return {"available": True, "project": project, "rootName": project["name"],
                    "stats": {"files": len(files), "image": sum(item["type"] == "image" for item in files), "sizeText": "fixture"},
                    "tree": {"kind": "folder", "name": project["name"], "path": project["folder"],
                             "fileCount": len(files), "children": folders}}


def handler_for(fixture):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def send(self, status, content, content_type="application/json"):
            if not isinstance(content, bytes):
                content = json.dumps(content, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            parsed = urlparse(self.path)
            params = parse_qs(parsed.query)
            if parsed.path == "/api/creative-assets":
                project_id = params.get("project", [PROJECTS["A"]["id"]])[0]
                key = next((key for key, project in PROJECTS.items() if project["id"] == project_id), None)
                if key is None:
                    self.send(400, {"error": "Unknown isolated fixture project"})
                    return
                with fixture.lock:
                    fixture.reads.append(project_id)
                    if fixture.fail_reads:
                        fixture.fail_reads -= 1
                        self.send(500, {"error": "隔离模拟重读失败"})
                        return
                    held = fixture.hold_queue.pop(0) if fixture.hold_queue else None
                    captured = fixture.tree(key)
                if held:
                    held["taken"].set()
                    try:
                        if not held["release"].wait(timeout=20):
                            self.send(504, {"error": "Isolated delayed fixture was not released"})
                            return
                        self.send(200, captured)
                    finally:
                        held["finished"].set()
                else:
                    self.send(200, captured)
                return
            if parsed.path == "/api/creative-assets/file" or parsed.path == "/favicon.ico":
                self.send(200, PNG, "image/png")
                return
            if parsed.path == "/api/production":
                self.send(200, {"available": False, "inbox": [], "stats": {}, "context": None})
                return
            if parsed.path.startswith("/api/"):
                self.send(200, {"projects": list(PROJECTS.values()), "activeProjectId": PROJECTS["A"]["id"], "items": []})
                return
            target = (ROOT / unquote(parsed.path).lstrip("/")).resolve()
            allowed = parsed.path.startswith("/assets/ui/") or target.name in {
                "creator.html", "creator.js", "creator.css", "creator-assets.html", "creator-assets.js",
                "creator-assets.css", "creator-automation-ui.js"}
            if not allowed or ROOT not in target.parents or not target.is_file():
                self.send(404, {"error": "Outside isolated fixture surface"})
                return
            self.send(200, target.read_bytes(), mimetypes.guess_type(str(target))[0] or "application/octet-stream")

        def do_POST(self):
            with fixture.lock:
                fixture.writes.append(self.path)
            self.send(405, {"error": "All fixture writes are forbidden; deletion uses explicit mock bridge"})

    return Handler


INIT_JS = r"""(() => {
  const projects = __PROJECTS__;
  const origin = __ORIGIN__;
  window.__bulk = { projects, active: 'A', calls: [], prompts: 0, rendererConfirms: [], pending: null, hasAPI: true,
    singleCalls: [], downloadCalls: [], eventSources: [], errors: [] };
  window.confirm = text => { __bulk.rendererConfirms.push(String(text)); return false; };
  window.EventSource = class {
    constructor() { this.listeners = {}; __bulk.eventSources.push(this); }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    close() {}
  };
  window.__emitBulkEvent = (type, data) => {
    for (const source of __bulk.eventSources) for (const cb of source.listeners[type] || []) cb({data: JSON.stringify(data)});
  };
  const browserState = { mode: 'image', serviceId: 'gpt', serviceLabel: 'GPT', tabId: 'bulk-fixture-tab',
    url: origin + '/creator.html', tabs: [{id:'bulk-fixture-tab', mode:'image', serviceId:'gpt',url:origin+'/creator.html'}],
    loading:false,canGoBack:false,canGoForward:false };
  const getConfig = async () => ({project: projects[__bulk.active], rootName: projects[__bulk.active].name,
    services:[{id:'gpt',label:'GPT',imageLabel:'GPT',videoLabel:'GPT',url:origin+'/creator.html'}],
    modeServices:{image:['gpt'],video:['gpt']},defaults:{image:'gpt',video:'gpt'},browser:browserState,
    paths:{creativeAssetAvailable:true,creativeAssetLibraryRoot:'/isolated-mock-only'},
    panel:{open:true,layout:'push',width:720},assetPanel:{open:false,layout:'push',width:720},testMode:true});
  const batch = async payload => {
    __bulk.calls.push(JSON.parse(JSON.stringify(payload))); __bulk.prompts++;
    return new Promise((resolve,reject) => { __bulk.pending = {resolve,reject}; });
  };
  window.__completeBulk = result => { const pending=__bulk.pending; if(!pending) throw new Error('No pending mock batch'); __bulk.pending=null; pending.resolve(result); };
  window.__rejectBulk = message => { const pending=__bulk.pending; if(!pending) throw new Error('No pending mock batch'); __bulk.pending=null; pending.reject(new Error(message)); };
  const creator = {getConfig,getDownloads:async()=>[],setAssetPanel:async patch=>({...patch,creativeAssetAvailable:true}),
    selectService:async()=>browserState,selectTab:async()=>browserState,setMode:async()=>browserState,
    deleteAssets:batch,deleteAsset:async path=>{__bulk.singleCalls.push(path);return true;},
    deleteBrowserDownload:async path=>{__bulk.downloadCalls.push(path);return true;}};
  window.creatorAPI = new Proxy(creator,{get(target,key){
    if(key==='deleteAssets' && !__bulk.hasAPI) return undefined;
    if(key in target) return target[key];
    return String(key).startsWith('on') ? ()=>()=>{} : async()=>({});
  }});
  const asset = {getConfig,setPanelState:async patch=>({open:true,layout:'push',width:720,...patch}),
    onPanelState:()=>()=>{},onDragResult:()=>()=>{},startDrag:()=>{},deleteItems:batch,
    deleteItem:async path=>{__bulk.singleCalls.push(path);return true;}};
  window.assetAPI = new Proxy(asset,{get(target,key){if(key==='deleteItems' && !__bulk.hasAPI)return undefined; return target[key];}});
})();"""


def snapshot(page, surface):
    return page.evaluate("""surface => ({
      project: surface==='quick'?state.projectId:activeProjectId(),
      selected: surface==='quick'?[...state.quickSelectionOrder]:[...state.selectedPaths],
      assets: (surface==='quick'?state.assetItems:state.assets).map(item=>item.path),
      busy: surface==='quick'?quickAssetDeletionBusy():state.batchDeleteBusy,
      calls: __bulk.calls, prompts: __bulk.prompts, rendererConfirms: __bulk.rendererConfirms,
      singleCalls: __bulk.singleCalls, downloadCalls: __bulk.downloadCalls,
      preview: surface==='quick'?quickPreviewItem?.path||'':state.preview?.path||'',
      previewOpen: document.querySelector(surface==='quick'?'#quickPreviewDialog':'#previewDialog').open,
      toast: document.querySelector(surface==='quick'?'#creatorToast':'#assetToast').textContent,
      count: document.querySelector(surface==='quick'?'#assetAccordionCount':'#librarySummary').textContent
    })""", surface)


def open_folders(page, surface):
    if surface == "quick":
        if page.locator("#assetAccordion").get_attribute("open") is None:
            page.locator("#assetAccordion > summary").click()
        row = page.locator('.quick-folder-row[data-folder-path="隔离剧本' + page.evaluate("__bulk.active") + '/人物资产"]')
        if row.locator(".quick-folder-chevron-wrap").get_attribute("aria-expanded") == "false":
            row.locator(".quick-folder-chevron-wrap").click()


def choose(page, surface, tokens):
    if surface == "quick":
        open_folders(page, surface)
        if page.locator("#quickMultiSelect").get_attribute("aria-pressed") != "true":
            page.locator("#quickMultiSelect").click()
        for token in tokens:
            page.locator('.asset-card-wrap[data-asset-path="' + token + '"] .asset-image-card').click()
    else:
        for token in tokens:
            card = page.locator('#assetGrid .asset-card[data-path="' + token + '"]')
            card.hover()
            card.locator(".asset-check").click()


def trigger(page, surface):
    expected_calls = page.evaluate("__bulk.calls.length") + 1
    page.locator("#quickSelDelete" if surface == "quick" else "#batchDelete").click()
    page.wait_for_function("n=>__bulk.calls.length === n", arg=expected_calls)


def complete(page, surface, result):
    page.evaluate("result=>__completeBulk(result)", result)
    page.wait_for_function("s => !(s==='quick'?quickAssetDeletionBusy():state.batchDeleteBusy)", arg=surface)
    page.wait_for_timeout(230)


def reply(tokens, deleted=None, failed=None, cancelled=False):
    return {"projectId": PROJECTS["A"]["id"], "requested": len(tokens), "cancelled": cancelled,
            "deleted": list(deleted or []), "failed": list(failed or [])}


def assert_cached_header(observed, surface):
    if surface == "library":
        assert "缓存剩 2 项" in observed["count"] and "正在核对目录" in observed["count"], observed
    else:
        assert observed["count"] == "2 张图片", observed


def change_project(page, surface, key):
    page.evaluate("key=>{__bulk.active=key;__emitBulkEvent('creative-projects',{project:__bulk.projects[key]});}", key)
    page.wait_for_function("({surface,id})=>(surface==='quick'?state.projectId:activeProjectId())===id && (surface==='quick'?state.assetItems:state.assets).some(item=>item.path.startsWith(__bulk.projects[__bulk.active].folder+'/'))",
                           arg={"surface": surface, "id": PROJECTS[key]["id"]})
    page.wait_for_timeout(210)


def begin_old_read(page, fixture, surface):
    held = fixture.hold_next_read()
    page.evaluate("s=>{window.__oldReadDone=false;window.__oldReadError='';window.__oldReadPromise=(s==='quick'?loadAssetItems():loadLibrary()).catch(error=>{window.__oldReadError=error.message;}).finally(()=>{window.__oldReadDone=true;});}", surface)
    assert held["taken"].wait(timeout=3), "Delayed old tree GET did not start"
    return held


def release_old_read(page, held, surface):
    page.evaluate("s=>{window.__arrayBeforeOldRead=s==='quick'?state.assetItems:state.assets;}", surface)
    held["release"].set()
    page.wait_for_function("__oldReadDone === true")
    assert held["finished"].wait(timeout=2), "Delayed old tree GET did not finish"
    page.wait_for_timeout(40)
    untouched = page.evaluate("s=>window.__arrayBeforeOldRead===(s==='quick'?state.assetItems:state.assets)", surface)
    assert untouched, "Old GET was adopted and replaced the current asset array"
    assert page.evaluate("__oldReadError") == "", page.evaluate("__oldReadError")


def stale_get_barrier(page, fixture, surface, initial):
    all_tokens = fixture.paths("A")
    original = all_tokens[:2]
    held_cancel = begin_old_read(page, fixture, surface)
    # Change real checkbox/card selection after the old library GET captured its
    # previousSelection, but before the deletion lock takes the new snapshot.
    choose(page, surface, [all_tokens[1], all_tokens[2]])
    updated = [all_tokens[0], all_tokens[2]]
    assert snapshot(page, surface)["selected"] == updated
    trigger(page, surface)
    assert snapshot(page, surface)["calls"][0]["paths"] == updated
    complete(page, surface, reply(updated, cancelled=True))
    before_cancel_old = snapshot(page, surface)
    release_old_read(page, held_cancel, surface)
    after_cancel_old = snapshot(page, surface)
    assert after_cancel_old["selected"] == updated, after_cancel_old
    assert after_cancel_old["assets"] == before_cancel_old["assets"], after_cancel_old

    page.locator("#quickSelClear" if surface == "quick" else "#clearSelection").click()
    choose(page, surface, original)
    held_partial = begin_old_read(page, fixture, surface)
    trigger(page, surface)
    fixture.remove("A", [original[0]])
    fixture.fail_reads = 1
    complete(page, surface, reply(original, deleted=[original[0]], failed=[{"path": original[1], "error": "隔离模拟失败"}]))
    before_partial_old = snapshot(page, surface)
    assert before_partial_old["selected"] == [original[1]] and len(before_partial_old["assets"]) == 2, before_partial_old
    assert "刷新" in before_partial_old["toast"] and "1 项" in before_partial_old["toast"], before_partial_old
    assert_cached_header(before_partial_old, surface)
    release_old_read(page, held_partial, surface)
    final = snapshot(page, surface)
    assert final["selected"] == [original[1]], final
    assert final["assets"] == before_partial_old["assets"] and original[0] not in final["assets"], final
    assert_cached_header(final, surface)
    deleted_card = page.locator(('.asset-card-wrap[data-asset-path="' if surface == "quick" else '#assetGrid .asset-card[data-path="') + original[0] + '"]')
    assert deleted_card.count() == 0, "Old GET restored the deleted card"
    assert len(final["calls"]) == 2 and final["prompts"] == 2 and not final["rendererConfirms"], final
    assert not final["singleCalls"] and not final["downloadCalls"], final
    return {"before": initial, "cancelledBeforeOldReturn": before_cancel_old, "cancelledAfterOldReturn": after_cancel_old,
            "partialBeforeOldReturn": before_partial_old, "after": final, "bothOldGetsIgnored": True}


def run_case(page, fixture, surface, case):
    tokens = fixture.paths("A")[:2]
    choose(page, surface, tokens)
    initial = snapshot(page, surface)
    assert initial["selected"] == tokens, initial

    if case == "stale_get_barrier":
        return stale_get_barrier(page, fixture, surface, initial)

    if case == "missing_api":
        page.evaluate("__bulk.hasAPI=false")
        page.locator("#quickSelDelete" if surface == "quick" else "#batchDelete").click()
        final = snapshot(page, surface)
        assert final["calls"] == [] and final["selected"] == tokens, final
        assert "桌面" in final["toast"], final
        return {"before": initial, "after": final}

    if case == "download_exclusion":
        download = fixture.add("A", "下载说明.pdf", "浏览器下载", "document")
        page.evaluate("s=>s==='quick'?loadAssetItems():loadLibrary()", surface)
        page.evaluate("({surface,download})=>{if(surface==='quick'){state.quickSelectionOrder.push(download,'download:fixture-id',state.config.project.folder);updateQuickSelectionUI();}else{state.selectedPaths.add(download);state.selectedPaths.add('download:fixture-id');updateSelectionBar();}}",
                      {"surface": surface, "download": download})
        trigger(page, surface)
        payload = snapshot(page, surface)["calls"][0]
        complete(page, surface, reply(payload["paths"], cancelled=True))
        assert payload["paths"] == tokens, payload
        assert snapshot(page, surface)["downloadCalls"] == [], snapshot(page, surface)
        return {"before": initial, "payload": payload, "after": snapshot(page, surface)}

    trigger(page, surface)
    pending = snapshot(page, surface)
    assert pending["calls"] == [{"projectId": PROJECTS["A"]["id"], "paths": tokens}], pending
    assert pending["prompts"] == 1 and not pending["rendererConfirms"], pending

    if case == "cancel":
        complete(page, surface, reply(tokens, cancelled=True))
        final = snapshot(page, surface)
        assert final["selected"] == tokens and final["assets"] == initial["assets"], final
        assert "取消" in final["toast"], final
    elif case == "success":
        fixture.remove("A", tokens)
        complete(page, surface, reply(tokens, deleted=tokens))
        final = snapshot(page, surface)
        assert final["selected"] == [] and len(final["assets"]) == 1, final
        assert tokens[0] not in final["assets"] and tokens[1] not in final["assets"], final
        assert "2 项" in final["toast"], final
        assert "1" in final["count"], final
    elif case in ("partial_failed_preview", "partial_success_preview", "partial_stop", "refresh_failure"):
        preview = tokens[1] if case == "partial_failed_preview" else tokens[0]
        if case not in ("partial_stop", "refresh_failure"):
            page.evaluate("({surface,path})=>{const item=(surface==='quick'?state.assetItems:state.assets).find(item=>item.path===path);return surface==='quick'?openQuickPreview(item):openPreview(item);}",
                          {"surface": surface, "path": preview})
            assert snapshot(page, surface)["previewOpen"], snapshot(page, surface)
        fixture.remove("A", [tokens[0]])
        if case == "refresh_failure":
            fixture.fail_reads = 1
        complete(page, surface, reply(tokens, deleted=[tokens[0]], failed=[{"path": tokens[1], "error": "隔离模拟失败"}], cancelled=case == "partial_stop"))
        if case == "partial_success_preview":
            page.wait_for_function("s=>!document.querySelector(s==='quick'?'#quickPreviewDialog':'#previewDialog').open", arg=surface)
        final = snapshot(page, surface)
        assert final["selected"] == [tokens[1]] and tokens[0] not in final["assets"] and tokens[1] in final["assets"], final
        assert "1 项" in final["toast"] and "失败" in final["toast"], final
        if case == "refresh_failure":
            assert len(final["assets"]) == 2 and "刷新" in final["toast"], final
            assert_cached_header(final, surface)
        if case == "partial_stop":
            assert "停止" in final["toast"], final
        if case == "partial_failed_preview":
            assert final["previewOpen"] and final["preview"] == tokens[1], final
        elif case == "partial_success_preview":
            assert not final["previewOpen"] and not final["preview"], final
    elif case == "lock_and_sse":
        busy_button = page.locator("#quickSelDelete" if surface == "quick" else "#batchDelete")
        assert busy_button.is_disabled(), pending
        page.evaluate("s=>{document.querySelector(s==='quick'?'#quickSelDelete':'#batchDelete').click();document.querySelector(s==='quick'?'#quickSelDelete':'#batchDelete').dispatchEvent(new MouseEvent('click',{bubbles:true}));}", surface)
        if surface == "quick":
            page.locator('.asset-card-wrap[data-asset-path="' + tokens[0] + '"] .asset-image-card').click()
            assert page.locator("#quickSelClear").is_disabled()
            assert page.locator("#quickMultiSelect").is_disabled()
        else:
            assert page.locator("#clearSelection").is_disabled()
            assert page.locator("#selectVisible").is_disabled()
            page.locator('#assetGrid .asset-card[data-path="' + tokens[0] + '"] .asset-check').dispatch_event("click")
        reads_before = len(fixture.reads)
        new_path = fixture.add("A")
        page.evaluate("id=>__emitBulkEvent('creative-assets',{projectId:id})", PROJECTS["A"]["id"])
        page.wait_for_timeout(260)
        during = snapshot(page, surface)
        assert len(during["calls"]) == 1 and during["selected"] == tokens, during
        assert len(fixture.reads) == reads_before, {"readsBefore": reads_before, "readsAfter": len(fixture.reads)}
        fixture.remove("A", tokens)
        complete(page, surface, reply(tokens, deleted=tokens))
        final = snapshot(page, surface)
        assert final["selected"] == [] and new_path in final["assets"], final
        assert len(fixture.reads) == reads_before + 1, {"readsBefore": reads_before, "readsAfter": len(fixture.reads)}
    elif case in ("project_switch", "project_roundtrip"):
        change_project(page, surface, "B")
        if case == "project_roundtrip":
            change_project(page, surface, "A")
        target = "A" if case == "project_roundtrip" else "B"
        new_token = fixture.paths(target)[2]
        # Old batch locks selection until it settles. Install a new-project
        # selection directly to model external state restoration while locked.
        page.evaluate("({s,path})=>{if(s==='quick'){state.quickSelectionOrder=[path];updateQuickSelectionUI();}else{state.selectedPaths=new Set([path]);updateSelectionBar();}}",
                      {"s": surface, "path": new_token})
        before_old = snapshot(page, surface)
        complete(page, surface, reply(tokens, deleted=tokens))
        final = snapshot(page, surface)
        assert final["project"] == PROJECTS[target]["id"] and final["selected"] == [new_token], final
        assert final["assets"] == before_old["assets"], final
        assert "废纸篓" not in final["toast"], final
    elif case == "rejected_bridge":
        page.evaluate("__rejectBulk('隔离模拟接口拒绝')")
        page.wait_for_function("s=>!(s==='quick'?quickAssetDeletionBusy():state.batchDeleteBusy)", arg=surface)
        final = snapshot(page, surface)
        assert final["selected"] == tokens and final["assets"] == initial["assets"], final
        assert "拒绝" in final["toast"], final
    else:
        raise AssertionError("Unknown case: " + case)

    assert not final["rendererConfirms"] and len(final["calls"]) == 1, final
    assert not final["singleCalls"] and not final["downloadCalls"], final
    return {"before": initial, "pending": pending, "after": final}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", default=str(ROOT / "test-artifacts/bulk-delete-ui-20261014"))
    parser.add_argument("--browser", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    parser.add_argument("--cases", help="Comma-separated case subset; default covers both pages and all contracts")
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    if not evidence.is_relative_to(ROOT / "test-artifacts"):
        raise RuntimeError("Evidence must remain under this worktree's test-artifacts")
    evidence.mkdir(parents=True, exist_ok=True)
    source_files = ["creator.html", "creator.js", "creator.css", "creator-assets.html", "creator-assets.js", "creator-assets.css",
                    "assets/ui/generated-video-layout.js", "assets/ui/video-disposition.js", "assets/ui/folder-editor.js", "assets/ui/asset-order.js"]
    receipt = {"scope": "real-full-pages-python-playwright-mock-native-delete-bridges", "formalAppTouched": False,
               "formalProfileOrDataTouched": False, "realTrashOperationPerformed": False,
               "rendererConfirmationExpected": False, "sourceHashes": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files},
               "reports": [], "pageErrors": [], "blockedWrites": [], "fixtureCleaned": False}
    cases = (args.cases.split(",") if args.cases else ["cancel", "success", "partial_failed_preview", "partial_success_preview", "partial_stop",
             "lock_and_sse", "project_switch", "project_roundtrip", "missing_api", "download_exclusion", "rejected_bridge", "refresh_failure", "stale_get_barrier"])
    fixture = Fixture()
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(fixture))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = "http://127.0.0.1:" + str(server.server_address[1])
    receipt["fixtureOrigin"] = origin
    receipt["browser"] = args.browser
    started = time.time()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=args.browser)
            try:
                for surface in ("quick", "library"):
                    for case in cases:
                        fixture.reset()
                        context = browser.new_context(viewport={"width": 1500, "height": 1000})
                        page = context.new_page()
                        case_errors = []
                        page.on("pageerror", lambda error: case_errors.append(str(error)))
                        page.set_default_timeout(6000)
                        report = {"surface": surface, "case": case, "status": "running"}
                        try:
                            init = INIT_JS.replace("__PROJECTS__", json.dumps(PROJECTS, ensure_ascii=False)).replace("__ORIGIN__", json.dumps(origin))
                            page.add_init_script(init)
                            page.goto(origin + ("/creator.html?mode=image" if surface == "quick" else "/creator-assets.html?surface=library"), wait_until="networkidle")
                            page.wait_for_function("document.body.dataset.ready === 'true'")
                            report.update(run_case(page, fixture, surface, case))
                            assert not case_errors, case_errors
                            assert not fixture.writes, fixture.writes
                            report["status"] = "passed"
                            if case in ("cancel", "partial_failed_preview", "success"):
                                page.screenshot(path=str(evidence / (surface + "-" + case + ".png")), full_page=True)
                            print("BULK_DELETE_UI_CASE_PASS", surface, case, flush=True)
                        except Exception as error:
                            report["status"] = "failed"
                            report["error"] = str(error)
                            report["stack"] = traceback.format_exc()
                            try:
                                report["observed"] = snapshot(page, surface)
                                page.screenshot(path=str(evidence / (surface + "-" + case + "-failed.png")), full_page=True)
                            except Exception:
                                pass
                            print("BULK_DELETE_UI_CASE_FAILED", surface, case, str(error)[:500], flush=True)
                        finally:
                            fixture.release_reads()
                            report["pageErrors"] = case_errors
                            receipt["pageErrors"].extend([surface + ":" + case + ":" + item for item in case_errors])
                            receipt["blockedWrites"].extend(fixture.writes)
                            receipt["reports"].append(report)
                            context.close()
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        receipt["fixtureCleaned"] = not thread.is_alive()
        receipt["elapsedSeconds"] = round(time.time() - started, 2)
        receipt["sourceHashesAtEnd"] = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in source_files}
        receipt["sourceChangedDuringRun"] = receipt["sourceHashes"] != receipt["sourceHashesAtEnd"]
        receipt["passed"] = sum(item["status"] == "passed" for item in receipt["reports"])
        receipt["failed"] = sum(item["status"] == "failed" for item in receipt["reports"])
        receipt["ok"] = receipt["failed"] == 0 and receipt["passed"] == len(cases) * 2 and not receipt["pageErrors"] and not receipt["blockedWrites"] and receipt["fixtureCleaned"] and not receipt["sourceChangedDuringRun"]
        (evidence / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print("BULK_DELETE_UI_RESULT", json.dumps({key: receipt[key] for key in ("ok", "passed", "failed", "fixtureCleaned")}), "evidence=" + str(evidence), flush=True)
    if not receipt["ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
