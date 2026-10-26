# Windows 源码复现 · v1.3.15

Windows 10/11 x64、Node.js 26.7.0；[固定源码](https://github.com/SJT-bright/video-production-os-windows/tree/v1.3.15) 与 Mac 同步核心功能，个人数据与登录不分发。

```powershell
npm ci
npm run desktop
```

源码运行使用自己的项目数据。完整下载版无需安装 Node.js，个人工作区在 `%APPDATA%\视频制作 OS\workspace`，登录与标签位于上级用户配置目录。

## 编译可分发音频组件

安装 MSYS2，在 MINGW64 终端安装 `make mingw-w64-x86_64-gcc` 后，从源码根目录执行：

```sh
curl --fail --location --output FFmpeg-6.1.1-source.tar.xz https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz
bash scripts/build-ffmpeg.sh "$PWD/FFmpeg-6.1.1-source.tar.xz" win32 x64 "$PWD/media-builds"
```

返回 PowerShell：

```powershell
$env:VIDEO_OS_FFMPEG_BUILD_ROOT = "$PWD/media-builds"
node prepare-media-tools.cjs win32 x64 --redistributable
npm run test:source
npx playwright install chromium
npm run test:script-import-episodes
npm run build:windows:release
node test_windows_release.cjs
```

输出 `dist\视频制作OS-win32-x64`，双击内部的 `视频制作OS.exe`。不要单独移动 EXE；DLL、resources、locales、音频组件必须保留。发布时同时提供匹配的 `FFmpeg-6.1.1-source.tar.xz` 与第三方说明，参见 `THIRD-PARTY-NOTICES.md`。

GitHub 的 `Build and publish desktop App` 工作流在实际 Windows runner 编译、启动 EXE、检查标签恢复／确认清空与包内音轨截取，通过后才建立本版本 Release。Mac 静态检查不代替 Windows EXE 验证；外部网站的实际生成与外部剪辑软件收件不属于这份自动验证。
