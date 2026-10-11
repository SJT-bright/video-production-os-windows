# Mac 源码复现 · v1.2.4

此版本固定 2026-10-09 的 Mac 功能源码及配套界面资源。目标是复现相同功能、布局和交互，不是复制作者的剧本、素材、网站登录或数据库，也不保证不同机器生成逐字节相同的签名安装包。

## 获取相同版本

需要 macOS、Git 和 Node.js。已验证的开发环境为 macOS 26.6.2 / Apple Silicon，Node.js 26.7.0 / npm 11.19.0；`.nvmrc` 固定 Node 版本。应用要求 Node.js 至少 22.12，依赖版本以 `package-lock.json` 为准：Electron 43.4.1、Packager 18.3.1、Playwright 1.62.1、ffmpeg-static 5.3.0。

```zsh
mkdir -p video-production-workspace
cd video-production-workspace
git clone --branch v1.2.4 https://github.com/SJT-bright/video-production-os.git 视频制作OS
cd 视频制作OS
# 如使用 nvm，可在这里执行 nvm install && nvm use
npm ci
npm run desktop
```

请使用 `npm ci`，不要删除锁文件，也不要加 `--omit=dev`。桌面运行、打包和音频组件都在开发依赖中。首次安装需要下载 npm 依赖、Electron 与 FFmpeg；创作网站需要使用者自己的账号。软件不内置图像／视频生成模型或付费平台额度。

也可以 [下载固定源码 ZIP](https://github.com/SJT-bright/video-production-os/archive/refs/tags/v1.2.4.zip)，解压后将源码目录改名为 `视频制作OS`，放到独立工作目录，再执行 `npm ci`。GitHub 的自动源码 ZIP 不含 `node_modules` 或 App，不能直接双击启动。

## 构建 Mac App

### 推荐：独立数据、可移动 App

```zsh
# Apple Silicon：M1/M2/M3/M4 等
npm run build:mac -- --arch arm64 --portable

# Intel Mac
npm run build:mac -- --arch x64 --portable

# 同时包含两种 CPU 架构（体积较大）
npm run build:mac -- --arch universal --portable
```

对应输出：

```text
dist/public-release/视频制作 OS-darwin-arm64/视频制作 OS.app
dist/public-release/视频制作 OS-darwin-x64/视频制作 OS.app
dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app
```

只执行适合自己机器的一条命令即可。构建脚本准备目标架构的音频组件，核验运行资源哈希、Info.plist、CPU 架构并执行本地签名；成功必须看到 `MAC_BUILD_CANDIDATE_PASS`。Apple Silicon 运行和构建已经隔离验证；Intel 和 universal 是现有构建路径，不将本次 arm64 验证冒充 Intel 实机验证。

`--portable` 构建不写作者的绝对路径，个人工作区位于 Electron `userData` 下的 `workspace`，macOS 默认通常为：

```text
~/Library/Application Support/视频制作 OS/workspace/
```

网站登录和标签状态位于同一 `userData` 的配置目录。源码启动及源码绑定构建使用另一套工作区，不自动迁移到 portable 数据目录。

### 可选：绑定源码项目的开发包

```zsh
npm run build:mac -- --arch arm64
```

输出 `dist/视频制作 OS-darwin-arm64/视频制作 OS.app`。它使用上级工作目录的 `创作资产库/`、`素材库/` 和源码目录的 `data/`。这条路径要求目录仍叫 `视频制作OS`，且 App 保持在源码目录内；不要单独把这种 App 移到“应用程序”。源码或整个项目位置改变后，用 `启动OS-mac.command` 校验／重建。

## 已实现的工作流

- 图片／视频双模式内嵌浏览器；标签右键操作、固定、静音、恢复、搜索、排序；切大厅或资产库后保留，清空需原生确认。
- 固定提示词及剧本段落原位改名、顶部复制；固定模板可主动迁移到其他剧本，两模式追加、去重、不覆盖旧内容。
- 分剧本图片、人物、场景、视频、音频、BGM／音效和成片；普通同级文件夹可调整显示顺序，日期和生成素材最新在前。
- 资产分类右键原位改名，保留分类身份与排序；新导入按当前名称加序号编号，关联音频、成片和下载路径同步更新。
- 普通浏览器下载仅展示非媒体文件；视频下载选择可剪辑／待处理后归档，锁定下载开始时的剧本、支持并发重名和未分类重启恢复。
- 右键视频置顶浮出、卡片展开动画、原文件拖出后收起；剪映联动小窗显示可剪辑视频与音频。
- 人物音频提取、波形与循环试听、默认 2.1 秒锁定、自由选区、名称与备注、保存本剧、另存为；输出 WAV / PCM 16 bit / 24 kHz / 单声道。
- 剪映音频及成片固定导出目录、稳定写入检测与自动入库；外部目录和 Obsidian 索引、复制复用、成片标记及搜索。

音频截取保留原视频的混合音轨，不自动分离人物、对白、BGM 或音效。剧本拆解、镜头台账、提示词队列与评分不作为当前功能入口。

## 自行验证

```zsh
# 语法、标签留存、日期排序、模板、下载、资产、项目、构建合同、真实音轨截取
npm run test:source

# 真实 Electron 窗口 / preload / IPC 的隔离检查（测试会打开自己的窗口）
npm run test:mac-native
```

测试生成自己的临时素材和浏览器配置，不需要作者的数据。音频用例解码真实测试音轨并核对 2.1 秒共 50,400 帧 PCM 采样；原生用例的一部分菜单决策和拖拽回执使用适配器。它们不证明剪映／Updream 真正收到文件，这一外部边界需要在目标电脑确认。

可选网页布局检查使用 Node Playwright 或文件名为 `test_*_ui.py` 的 Python Playwright 脚本；Python 不是运行 App 或构建 App 的必需依赖。执行这些脚本时应给隔离测试服务器地址，不把正式工作区作为测试夹具。

## 音频组件与分发边界

本仓库只发布自有源码和界面资源；不提交 Electron、FFmpeg 或本地 App 二进制。FFmpeg 通过固定的 `ffmpeg-static@5.3.0` / `b6.1.1` 准备，构建目录保留其 SHA-256、来源及许可文件；[上游说明](https://github.com/eugeneware/ffmpeg-static) 与 [FFmpeg 许可说明](https://ffmpeg.org/legal.html) 应分别核对。

当前 arm64 上游二进制的实际版本为 6.0，配置包含 `--enable-nonfree`。它用于本次本地复现验证，**不作为本项目可公开分发的安装包组件**。若再发布安装包，应先换成许可允许分发的音频组件构建并完成对应验证；不要把项目自身的 MIT 许可证误用于整个 FFmpeg 二进制。

构建包采用本地 ad-hoc 签名，未 Apple 公证。构建时间、签名与系统差异会影响成品字节，因此验收依据是固定源码提交、资源哈希和实际功能，而不是不同机器 App 的整包哈希相同。
