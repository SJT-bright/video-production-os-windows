#!/usr/bin/env python3
"""Actual page templates/support component; other App scripts intentionally omitted.

Use an isolated static server. Desktop methods and update messages are explicit
fixtures, not actual Electron IPC, GitHub publication or an account Star action.
The packaged native suite verifies the real host/preload integration separately.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
RESOURCES = ["creator.html", "index.html", "assets/ui/app-support.js", "assets/ui/app-support.css"]


def hashes():
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in RESOURCES}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    origin = urlparse(args.base)
    assert origin.hostname in ("localhost", "127.0.0.1") and origin.port != 3750
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    receipt = {"scope": "static real page templates and shared support controller; explicit desktop bridge fixtures",
               "formalAppTouched": False, "realGitHubStarPerformed": False,
               "sourceHashes": hashes(), "reports": [], "pageErrors": []}
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                for page_name in ["creator.html", "index.html"]:
                    for platform in ["mac", "windows"]:
                        context = browser.new_context(viewport={"width": 1280, "height": 900})
                        page = context.new_page()
                        page.on("pageerror", lambda error: receipt["pageErrors"].append(str(error)))
                        raw = (ROOT / page_name).read_text()
                        template = re.sub(r'<script\b[^>]*>.*?</script>', '', raw, flags=re.S | re.I)
                        template = template.replace("</body>", '<script src="assets/ui/app-support.js"></script></body>')
                        page.route("**/" + page_name, lambda route: route.fulfill(status=200, content_type="text/html", body=template))
                        repo = "video-production-os-windows" if platform == "windows" else "video-production-os"
                        star = "https://github.com/SJT-bright/" + repo
                        params = {"starUrl": star, "currentVersion": "1.3.11", "status": "idle", "checking": False,
                                  "available": False, "release": None, "revision": 0}
                        page.add_init_script("""(params => {
                          window.__supportTest = {stars:[], releases:[], checks:0, listeners:[]};
                          let current = params;
                          window.__supportReceive = next => { current = next; window.__supportTest.listeners.forEach(fn => fn(next)); };
                          window.desktopOS = {
                            getAppReleaseState: async () => current,
                            onAppReleaseState: fn => { window.__supportTest.listeners.push(fn); return () => {}; },
                            openGitHubStar: async () => { window.__supportTest.stars.push(current.starUrl); },
                            openAppRelease: async () => { window.__supportTest.releases.push(current.release.url); },
                            checkAppUpdates: async () => {
                              window.__supportTest.checks++;
                              await new Promise(resolve => setTimeout(resolve, 50));
                              const next = {...current, revision:current.revision+1, status:'available', available:true,
                                release:{version:'1.3.12', url:current.starUrl+'/releases/tag/v1.3.12'}};
                              window.__supportReceive(next); return next;
                            }
                          };
                        })(""" + json.dumps(params) + ");")
                        page.goto(args.base + "/" + page_name, wait_until="networkidle")
                        page.get_by_role("button", name="检查软件更新").wait_for()
                        page.locator("[data-app-star]").first.click()
                        assert page.evaluate("window.__supportTest.stars") == [star]
                        assert page.locator("[data-app-star]").first.get_attribute("href") == star
                        page.locator("[data-app-update]").evaluate("node => {node.click(); node.click();}")
                        page.wait_for_function("document.querySelector('[data-app-update]').dataset.updateAvailable === 'true' && !document.querySelector('[data-app-update]').disabled")
                        assert page.evaluate("window.__supportTest.checks") == 1
                        assert "1.3.12" in page.locator("[data-app-update]").inner_text()
                        page.get_by_role("button", name="更新到 v1.3.12").click()
                        assert page.evaluate("window.__supportTest.releases") == [star + "/releases/tag/v1.3.12"]
                        # A delayed initial/manual reply cannot overwrite a newer event.
                        page.evaluate("""base => {
                          window.__supportReceive({...base, revision:5, available:true, status:'available', release:{version:'1.3.13',url:base.starUrl+'/releases/tag/v1.3.13'}});
                          window.__supportReceive({...base, revision:1, available:false, status:'up-to-date', release:null});
                        }""", params)
                        assert "1.3.13" in page.locator("[data-app-update]").inner_text()
                        page.evaluate("base => window.__supportReceive({...base, revision:6, status:'error', error:'offline'})", params)
                        assert page.locator("[data-app-update-label]").inner_text() == "重试更新"
                        assert page.locator("[data-app-update]").get_attribute("title") == "offline"
                        for width in [1280, 1100, 980]:
                            page.set_viewport_size({"width": width, "height": 900})
                            rect = page.locator("[data-app-update]").bounding_box()
                            assert rect and rect["x"] >= 0 and rect["x"] + rect["width"] <= width + 1, (page_name, width, rect)
                        receipt["reports"].append({"page": page_name, "platform": platform, "passed": True,
                                                   "star": star, "singleCheck": True, "newerEventWins": True, "errorNotUpToDate": True})
                        context.close()
                page = browser.new_page()
                page.on("pageerror", lambda error: receipt["pageErrors"].append(str(error)))
                raw = (ROOT / 'creator.html').read_text()
                preview = re.sub(r'<script\b[^>]*>.*?</script>', '', raw, flags=re.S | re.I)
                preview = preview.replace('</body>', '<script src="assets/ui/app-support.js"></script></body>')
                page.route('**/creator.html', lambda route: route.fulfill(status=200, content_type='text/html', body=preview))
                page.goto(args.base + "/creator.html", wait_until="networkidle")
                assert page.locator("[data-app-update]").is_disabled()
                assert page.locator("[data-app-star]").get_attribute("href") == "https://github.com/SJT-bright/video-production-os"
                receipt["reports"].append({"page": "creator.html", "platform": "browser-preview", "passed": True, "nativeCapabilityNotFaked": True})
                page.close()
            finally:
                browser.close()
        receipt["sourceHashesAtEnd"] = hashes()
        assert receipt["sourceHashes"] == receipt["sourceHashesAtEnd"]
        assert not receipt["pageErrors"]
        receipt["ok"] = True
        print("GITHUB_UPDATES_UI_PASS 5 groups; real templates, bridge fixture, both platforms, stale guard")
    finally:
        (evidence / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
