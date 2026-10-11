# Windows 源码复现 · v1.2.4

面向 Windows 10/11 x64，同步 Mac v1.2.4 的完整功能，并纳入 2026-10-11 的纯数字编号与平台素材目录调整。`source-v1.2.4` 是源码标签，不是旧版 v1.2.3 EXE 包。个人素材、数据库和网站登录不随仓库分发。

## 下载、运行和构建

安装 Git 和 Node.js 22.23.3，打开 PowerShell，在独立工作目录执行：

```powershell
mkdir video-production-workspace
cd video-production-workspace
git clone --branch source-v1.2.4 https://github.com/SJT-bright/video-production-os-windows.git 视频制作OS
cd 视频制作OS
npm ci
npm run desktop
```

也可 [下载固定源码 ZIP](https://github.com/SJT-bright/video-production-os-windows/archive/refs/tags/source-v1.2.4.zip)，解压为 `视频制作OS` 后执行最后两条命令。请使用 `npm ci`，保留锁文件，不加 `--omit=dev`。Windows 构建使用 `.nvmrc` 固定的 Node 22.23.3 LTS，与 Mac 历史源码的构建版本分别验证；首次安装会下载 Electron 和 FFmpeg。

构建独立数据的完整 Windows App：

```powershell
npm run test:source
npm run build:windows:release
node test_windows_release.cjs
```

输出目录：`dist\视频制作OS-win32-x64`。完整复制这个目录，双击里面的 `视频制作OS.exe`；不能只移动 EXE，DLL、resources、locales 和音频组件必须保留。运行构建产物不需要另装 Node.js。

portable 构建不记录开发者绝对路径。素材、剧本和数据库位于 `%APPDATA%\视频制作 OS\workspace`，标签与登录位于 `%APPDATA%\视频制作 OS`。源码启动使用独立工作目录的素材和数据，不自动迁入 portable 工作区。

## 最新功能

- 图片／视频浏览器、紧凑标签、原生右键菜单、排序、固定／静音、会话留存和清空确认。
- 固定提示词／剧本原位改名、顶部复制；两模式模板主动迁移，追加、去重、不覆盖。
- 人物音频提取、波形与循环试听、默认 2.1 秒、自由选区、命名／备注、保存本剧和另存为。输出 WAV / PCM 16 bit / 24 kHz / 单声道；截取原混合音轨，不自动分离人物或 BGM。
- 视频下载选择可剪辑／待处理，固定下载开始时的剧本，同名并发不覆盖，未分类可重启恢复。普通浏览器下载只显示非媒体文件。
- 右键视频置顶浮出、卡片展开、拖出后收起；剪映小窗显示首帧和可剪辑素材。保留 Windows `move` 事件的位置记忆修正。
- 分类原位改名、同级排序、删除不复生，以及音频／成片／下载记录路径同步。新文件只用 `001.ext`、`002.ext`；分类改名和删除最高编号不重置计数。
- 生成视频在剧本／状态／平台下的“素材001”目录跨日追加，旧日期目录不移动。剪映固定导出目录、稳定写入检测、外部目录及 Obsidian 复用继续保留。
- Windows 短目录名（例如 `RUNNER~1`）先解析真实路径再监听，避免目录变动导致服务原生崩溃；素材目录登记值不变。

## 验证与开源

`.github/workflows/check-windows-source.yml` 在实际 Windows runner 中安装依赖、检查共享源码、构建 x64 App、启动打包 EXE，验证浏览器留存／清空、包内音频截取、模板迁移、下载分类、分类改名和浮窗位置。Mac 本机检查不能代替 Windows EXE 验证。

测试数据均隔离；部分系统菜单选择和拖拽回执使用适配器，不等于剪映真实接收验收。第三方网站需要使用者自己的账号、网络和平台额度。

自有源码与界面资源按 [MIT](LICENSE) 开源，Electron、FFmpeg 等组件使用各自上游许可。源码标签不提交或附加组件二进制；构建脚本准备 Windows x64 音频组件，记录来源、许可文件与 SHA-256。重新分发二进制时需保留对应组件文件，不能把项目 MIT 许可当作所有组件的许可。

现有 `Release Windows EXE` 工作流仍用于另行发布安装包；本次 `source-v*` 标签不会触发它，旧版 v1.2.3 下载包不自动更新。
