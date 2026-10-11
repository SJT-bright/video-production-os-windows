"""隔离服务上的人物音频 UI 验收。桌面 IPC 用最小适配器，不声称原生另存为已实测。"""
import argparse
import io
import json
import os
import time
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument("base")
parser.add_argument("--out", default="test-artifacts/voice-clips")
args = parser.parse_args()
out = Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)

def pcm_info(data):
    with wave.open(io.BytesIO(data), "rb") as wav:
        return wav.getnframes() / wav.getframerate(), wav.getframerate(), wav.getnchannels()

with sync_playwright() as p:
    browser_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    browser = p.chromium.launch(headless=True, executable_path=browser_path if os.path.isfile(browser_path) else None)
    context = browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    # SSE 与本次截取无关；关闭测试页的重连流，让 networkidle 可确定。
    context.route("**/api/events", lambda route: route.fulfill(status=200, content_type="text/event-stream", body=""))
    deadline = time.monotonic() + 15
    while True:
        projects = context.request.get(args.base + "/api/creative-projects").json()
        project = next((x for x in projects["projects"] if x["id"] == projects["activeProjectId"] and x["name"] == "人物音频测试剧本"), None)
        if project:
            tree = context.request.get(args.base + "/api/creative-assets?project=" + project["id"]).json()
            if tree["stats"]["video"] == 2:
                break
        if time.monotonic() > deadline:
            raise AssertionError("隔离视频夹具未就绪")
        time.sleep(.1)
    source = project["folder"] + "/生成视频/对白测试.mp4"
    errors = []
    page = context.new_page()
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(args.base + "/creator-assets.html?surface=library")
    page.wait_for_load_state("networkidle")
    expect(page.locator("body")).to_have_attribute("data-ready", "true")
    cards = page.locator('.asset-card[data-kind="video"]')
    assert cards.count() == 2, page.locator("#assetStatus").inner_text()
    print("VOICE_UI_DOM:", page.locator("#assetGrid button").all_text_contents())
    page.locator('.asset-card[data-path="' + source + '"] .asset-preview-button').click()
    dialog = page.locator("#previewDialog")
    expect(dialog).to_have_attribute("open", "")
    dialog.get_by_role("button", name="人物音频", exact=True).click()
    panel = dialog.locator(".voice-clip-panel")
    expect(panel.locator(".voice-editor")).to_be_visible(timeout=20000)
    expect(panel.locator(".voice-duration")).to_have_text("2.10 秒")
    expect(panel.get_by_label("锁定 2.1 秒", exact=True)).to_be_checked()
    assert panel.locator("canvas").evaluate("el => el.width > 100")

    start = panel.get_by_label("开始", exact=True)
    end = panel.get_by_label("结束", exact=True)
    start.fill("1")
    start.press("Tab")
    expect(end).to_have_value("3.10")
    panel.get_by_role("button", name="试听片段", exact=True).click()
    expect(panel.get_by_role("button", name="停止试听", exact=True)).to_be_visible()
    page.wait_for_function("() => document.querySelector('.voice-track').currentTime > 1.1 && !document.querySelector('.voice-track').paused")
    # 超过选区长度，循环应仍在选择范围内。
    page.wait_for_timeout(2250)
    playing_time = panel.locator("audio").evaluate("el => el.currentTime")
    assert 1 <= playing_time < 3.11, playing_time
    panel.get_by_role("button", name="停止试听", exact=True).click()

    wave_box = panel.locator(".voice-wave").bounding_box()
    handle = panel.get_by_role("slider", name="截取开始时间").bounding_box()
    before_drag = float(start.input_value())
    page.mouse.move(handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2)
    page.mouse.down()
    page.mouse.move(handle["x"] + handle["width"] / 2 + wave_box["width"] * .16, handle["y"] + handle["height"] / 2, steps=12)
    page.mouse.up()
    assert float(start.input_value()) > before_drag + .8
    expect(panel.locator(".voice-duration")).to_have_text("2.10 秒")
    panel.get_by_label("锁定 2.1 秒", exact=True).uncheck()
    start.fill("1"); start.press("Tab")
    end.fill("4"); end.press("Tab")
    expect(panel.locator(".voice-duration")).to_have_text("3.00 秒")
    panel.get_by_label("锁定 2.1 秒", exact=True).check()
    expect(end).to_have_value("3.10")
    panel.get_by_label("音频名称", exact=True).fill("女主-浏览器试听音色")
    panel.locator("summary").click()
    panel.get_by_label("人物名称", exact=True).fill("女主")
    panel.get_by_label("音色描述", exact=True).fill("清亮、自然、平静")
    panel.get_by_role("button", name="保存到本剧", exact=True).click()
    expect(panel.locator(".voice-result")).to_be_visible(timeout=10000)
    expect(panel.locator(".voice-result")).to_contain_text("女主-浏览器试听音色.wav")
    library = context.request.get(args.base + "/api/audio-library?project=" + project["id"]).json()
    clip = next(x for x in library["items"] if x["name"] == "女主-浏览器试听音色")
    assert clip["kind"] == "voice" and clip["characterName"] == "女主"
    assert clip["sourcePath"] == source and clip["sourceStart"] == 1 and clip["sourceEnd"] == 3.1
    with page.expect_download() as downloading:
        panel.get_by_role("button", name="另存为…", exact=True).click()
    downloaded = downloading.value
    assert downloaded.suggested_filename == "女主-浏览器试听音色.wav"
    assert pcm_info(Path(downloaded.path()).read_bytes()) == (2.1, 24000, 1)
    # 同名第二次保存自动编号，不覆盖第一次。
    panel.get_by_role("button", name="保存到本剧", exact=True).click()
    expect(panel.locator(".voice-result")).to_contain_text("女主-浏览器试听音色-2.wav")
    page.screenshot(path=str(out / "library-audio-editor.png"))
    panel.get_by_role("button", name="试听片段", exact=True).click()
    panel.get_by_role("button", name="收起", exact=True).click()
    expect(panel).to_be_hidden()
    assert panel.locator("audio").evaluate("el => el.paused")
    dialog.get_by_role("button", name="人物音频", exact=True).click()
    expect(panel.locator(".voice-result")).to_contain_text("女主-浏览器试听音色-2.wav")
    dialog.get_by_role("button", name="关闭预览", exact=True).click()
    expect(dialog).not_to_have_attribute("open", "")
    expect(dialog.locator("audio")).to_have_count(0)
    # 无音轨给出准确原因，不产生空音频。
    page.locator('.asset-card[data-path="' + project["folder"] + '/生成视频/无音轨.mp4"] .asset-preview-button').click()
    dialog.get_by_role("button", name="人物音频", exact=True).click()
    expect(dialog.locator(".voice-status")).to_contain_text("没有可提取的音轨")
    dialog.get_by_role("button", name="关闭预览", exact=True).click()

    # 创作浏览器需要 Electron API。仅适配框架状态；音轨、保存和素材树仍调用真实隔离后端。
    creator = context.new_page()
    creator.on("pageerror", lambda error: errors.append(str(error)))
    creator.add_init_script("""(() => {
      const project = PROJECT;
      const service = {id:'gpt', label:'GPT', imageLabel:'GPT 图片', videoLabel:'GPT 提示词', url:'about:blank'};
      const browser = mode => ({mode, serviceId:'gpt', title:'测试', url:'about:blank', displayUrl:'about:blank', tabs:[], activeTabId:'', loading:false});
      const api = {
        getConfig: async () => ({ project, services:[service], modeServices:{image:['gpt'], video:['gpt']},
          defaults:{image:'gpt', video:'gpt'}, paths:{creativeAssetAvailable:true}, browser:browser('video'), testMode:true }),
        getDownloads: async () => [],
        setMode: async mode => browser(mode),
        setAssetPanel: async patch => ({...patch, creativeAssetAvailable:true}),
      };
      window.creatorAPI = new Proxy(api, {get(target, key) {
        if (key in target) return target[key];
        if (key === 'saveAudioAs') return undefined;
        if (String(key).startsWith('on')) return () => () => {};
        return async () => undefined;
      }});
    })();""".replace("PROJECT", json.dumps(project, ensure_ascii=False)))
    creator.goto(args.base + "/creator.html?mode=video&project=" + project["id"])
    creator.wait_for_load_state("networkidle")
    expect(creator.locator("body")).to_have_attribute("data-ready", "true")
    row = creator.locator(".quick-folder-row").filter(has=creator.get_by_role("button", name="生成视频", exact=True)).first
    toggle = row.get_by_role("button", name="生成视频", exact=True)
    if toggle.get_attribute("aria-expanded") != "true":
        toggle.click()
    card = creator.locator("#quickFolderTree .asset-image-card.video").filter(has_text="对白测试.mp4").first
    if not card.is_visible():
        # 日期分组也可收起，按当前 DOM 展开其父分组。
        for collapsed in creator.locator('#quickFolderTree .quick-folder-name[aria-expanded="false"]').all():
            if collapsed.is_visible():
                collapsed.click()
    card.click()
    quick = creator.locator("#quickPreviewDialog")
    quick.get_by_role("button", name="人物音频", exact=True).click()
    expect(quick.locator(".voice-editor")).to_be_visible(timeout=20000)
    expect(quick.locator(".voice-duration")).to_have_text("2.10 秒")
    quick.get_by_label("音频名称", exact=True).fill("男主-快捷面板音色")
    quick.get_by_role("button", name="保存到本剧", exact=True).click()
    expect(quick.locator(".voice-result")).to_contain_text("男主-快捷面板音色.wav")
    creator.screenshot(path=str(out / "creator-audio-editor.png"))
    quick.get_by_role("button", name="关闭", exact=True).last.click()
    expect(quick.locator("audio")).to_have_count(0)
    # 原图片模式与视频模式共用同一个资产预览，不另起一套音色数据。
    for mode in ["image", "video"]:
        creator.get_by_role("button", name="图片模式" if mode == "image" else "视频模式", exact=True).click()
        expect(creator.locator("body")).to_have_attribute("data-mode", mode)
    library = context.request.get(args.base + "/api/audio-library?project=" + project["id"]).json()
    assert len([x for x in library["items"] if x["kind"] == "voice"]) == 3
    assert len(library["items"]) == 3
    # 窄窗布局可滚动到保存按钮，不产生水平溢出。
    page.set_viewport_size({"width": 520, "height": 720})
    page.locator('.asset-card[data-path="' + source + '"] .asset-preview-button').click()
    dialog.get_by_role("button", name="人物音频", exact=True).click()
    expect(dialog.locator(".voice-editor")).to_be_visible(timeout=20000)
    expect(dialog.get_by_role("button", name="保存到本剧", exact=True)).to_be_visible()
    assert dialog.evaluate("el => el.scrollWidth <= el.clientWidth + 2")
    page.screenshot(path=str(out / "narrow-audio-editor.png"))
    assert not errors, errors
    browser.close()
    report = {"passed": True, "evidence": "隔离源代码服务与浏览器 UI；creatorAPI 为测试适配器，不含原生另存为验收",
              "checks": ["拖动选区", "2.1 秒锁定与自由长度", "真实音轨播放与循环", "命名与人物备注", "保存与重复命名", "WAV 下载", "两个资产预览入口", "收起/关闭停止播放", "无音轨反馈", "窄窗可操作"],
              "screenshots": ["library-audio-editor.png", "creator-audio-editor.png", "narrow-audio-editor.png"]}
    (out / "ui-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("VOICE_CLIPS_UI_PASS", json.dumps(report, ensure_ascii=False))
