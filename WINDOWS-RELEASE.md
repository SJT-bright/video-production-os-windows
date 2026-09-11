# 视频制作 OS - Windows 版本发布说明

本仓库用于 Windows 发行版本隔离发布（与 macOS 主仓库分开维护）。

## 版本说明

- 主程序源码与运行逻辑与 macOS 版一致
- Windows 发行为 `dist/视频制作OS-win32-x64/视频制作OS.exe`
- 应用内置的 `compatibilityMode` 会在 Windows 下维持兼容策略，不影响 macOS 主线

## 构建 Windows EXE（在 Windows 环境）

1. 安装 Node.js 22.12+（建议 22.x LTS）
2. 打开 PowerShell，进入仓库根目录
3. 安装依赖：

```powershell
npm ci
```

4. 生成 Windows 桌面版：

```powershell
npm run build:desktop
```

5. 运行：

```powershell
cd dist\视频制作OS-win32-x64
./视频制作OS.exe
```

## 常用命令

- `npm run browser`：启动浏览器兼容版（不内嵌桌面浏览器）
- `npm run desktop`：本地开发桌面模式（直接运行当前源码）
- `npm run build:desktop`：打包 Windows 独立目录
- `npm run test:desktop-package`：检查桌面发行包文件结构

## 发布建议

- 每次发版前清理旧 dist：`Remove-Item -Recurse -Force .\dist\视频制作OS-win32-x64`
- 重新执行 `npm run build:desktop`
- 将 `dist/视频制作OS-win32-x64/视频制作OS.exe` 作为发布产物分发

注：由于 Windows 打包依赖 Windows 可执行环境，建议在 Windows 机器上进行最终打包与签名流程。
