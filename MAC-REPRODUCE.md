# Mac 源码复现 · v1.3.4

下载 [固定源码](https://github.com/SJT-bright/video-production-os/tree/v1.3.4)，使用 macOS、Node.js 26.7.0 与锁文件中的依赖；源码目录建议命名为 `视频制作OS`。

```sh
npm ci
npm run desktop
```

源码运行不需要构建 App。新工作区使用自己的素材和账号，不包含作者数据。公开下载包使用 `userData/workspace`；绑定源码的开发包使用项目自己的数据，两者不会自动迁移。

## 构建可分发的 App

需要 Xcode Command Line Tools（clang、make）与 curl。先编译固定的 LGPL 音频组件，公开构建拒绝直接使用含 nonfree 的旧上游组件。

```sh
curl --fail --location --output FFmpeg-6.1.1-source.tar.xz https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz
export VIDEO_OS_FFMPEG_BUILD_ROOT="$PWD/media-builds"
bash scripts/build-ffmpeg.sh "$PWD/FFmpeg-6.1.1-source.tar.xz" darwin arm64 "$VIDEO_OS_FFMPEG_BUILD_ROOT"
bash scripts/build-ffmpeg.sh "$PWD/FFmpeg-6.1.1-source.tar.xz" darwin x64 "$VIDEO_OS_FFMPEG_BUILD_ROOT"
node prepare-media-tools.cjs darwin universal --redistributable
npm run test:source
npm run build:mac -- --arch universal --portable
node test_mac_release.cjs --arch universal
```

输出 `dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app`。只需要一种架构时，分别把 prepare/build 参数改为 `arm64` 或 `x64`，且只编译对应组件。

App 保留组件许可、自有 MIT 许可和第三方说明。重新公开分发时，同时提供 `FFmpeg-6.1.1-source.tar.xz`；匹配源码 SHA-256 和全部编译选项见 `scripts/build-ffmpeg.sh`。构建生成本地签名，不是 Apple 公证包。源码、组件配置和资源哈希可核对，但不同主机的构建时间及签名字节不一定相同。

## 检查

```sh
npx playwright install chromium
npm run test:script-import-episodes
npm run test:mac-native
```

测试使用隔离数据；原生菜单选择／拖拽有适配器用例，不证明外部网站或剪映真实收件。universal 包包含两架构，但启动测试仅覆盖当前主机实际运行的架构。`npm run build:mac -- --arch arm64` 不带 portable 是绑定源码项目的本地开发包，不可直接单独移动。
