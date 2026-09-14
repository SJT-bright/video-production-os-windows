# Windows 下载与发布

[下载最新版](https://github.com/SJT-bright/video-production-os-windows/releases/latest)

下载 `VideoProductionOS-Windows-x64.zip`，完整解压后双击 `视频制作OS.exe`。无需安装 Node.js。EXE 必须与旁边的 DLL、resources、locales 等文件保持在一起；旧版只提供单个主 EXE，不能作为完整安装包使用。

Windows x64 下载版与主项目同步创作浏览器、分剧本资产、音频／成片索引与固定提示词代码。第三方平台仍可能限制内嵌登录。

## 数据留存

- 素材、剧本注册表及数据库：`%APPDATA%\视频制作 OS\workspace`
- 浏览器登录、标签记忆和网站入口：`%APPDATA%\视频制作 OS`
- 更新时退出应用，解压新版到新的软件文件夹并启动；原用户目录继续复用。
- 不包含开发者的剧本、素材、数据库或登录信息。源码绑定构建的数据仍留在原项目目录，不会自动迁入下载版。

## 构建

需要 Node.js 22.12+，在源码目录执行：

```powershell
npm ci
npm run build:windows:release
node test_windows_release.cjs
```

输出目录：`dist/视频制作OS-win32-x64`。`--portable` 不记录构建机绝对路径。`npm run build:desktop` 仍用于绑定本机源码项目的开发包。

## GitHub Release

仅 Windows 独立仓库运行 `Release Windows EXE` 工作流。推送 `v*` 标签，或从 Actions 手动输入新版本标签，即执行构建、资源哈希核验、Windows EXE 启动与数据路径检查，发布完整 ZIP 和 `SHA256SUMS.txt`。

不要把 GitHub 自动生成的 Source code ZIP 当作可运行软件包。
