'use strict';

// 创作浏览器页面环境补丁（主世界注入）：
// Google 登录等页面会通过 navigator.plugins、window.chrome、navigator.webdriver
// 指纹判断“浏览器可能不安全”并拒绝登录。此 preload 在页面脚本执行前，
// 通过 webFrame.executeJavaScript 把环境补丁注入主世界，使其与标准 Chrome 一致。
const { webFrame, webUtils, ipcRenderer } = require('electron');

// Keep the page's File/Fetch APIs untouched. A trusted native drop or file-input
// choice authorizes only those selected files for GPT's later file-handle reads.
// No bridge, path, file bytes or permission controls are exposed to page scripts.
if (window === window.top && location.origin === 'https://chatgpt.com') {
  const authorizeFiles = (event, files) => {
    if (!event.isTrusted || !files?.length) return;
    const paths = [];
    for (const file of Array.from(files).slice(0, 100)) {
      try {
        const selectedPath = webUtils.getPathForFile(file);
        if (selectedPath) paths.push(selectedPath);
      } catch {}
    }
    // One bounded memory-only IPC precedes the page's first getFile() call.
    // Async fire-and-forget could race Chromium's separate permission channel.
    if (paths.length) ipcRenderer.sendSync('creator:selected-file-read', paths);
  };
  window.addEventListener('drop', event => authorizeFiles(event, event.dataTransfer?.files), true);
  window.addEventListener('change', event => {
    const input = event.target;
    if (input instanceof HTMLInputElement && input.type === 'file') authorizeFiles(event, input.files);
  }, true);
}

// 主世界没有 Node：版本号在 preload 侧算好，再插值进补丁脚本。
const CHROME_FULL = String(process.versions.chrome || '');
const CHROME_MAJOR = CHROME_FULL.split('.')[0] || '120';
const OS_PLATFORM_VERSION = process.platform === 'darwin' ? '15.7.0' : '10.0.0';
const ARCHITECTURE = process.arch === 'arm64' ? 'arm' : 'x86';

const PATCH = `
(function () {
  if (window.__vosChromePatched) return;
  window.__vosChromePatched = true;
  try {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  } catch (error) {}
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        connect: function () { return {}; },
        sendMessage: function () {},
        id: undefined,
      };
    }
    if (!window.chrome.loadTimes) window.chrome.loadTimes = function () { return {}; };
    if (!window.chrome.csi) window.chrome.csi = function () { return {}; };
    if (!window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        getDetails: function () { return null; },
        getIsInstalled: function () { return null; },
        InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed', DISABLED: 'disabled' },
        RunningState: { RUNNING: 'running', CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', NOT_RUNNING: 'not_running' },
      };
    }
  } catch (error) {}
  try {
    // userAgentData 品牌：Chromium 内核默认报 “Chromium”，Google 会与 UA 中的 Chrome 交叉比对。
    const chromeMajor = '${CHROME_MAJOR}';
    const chromeBrands = [
      { brand: ' Not A Brand', version: '99' },
      { brand: 'Chromium', version: chromeMajor },
      { brand: 'Google Chrome', version: chromeMajor },
    ];
    if (navigator.userAgentData) {
      Object.defineProperty(navigator.userAgentData, 'brands', {
        get: () => chromeBrands.map(entry => ({ ...entry })),
        configurable: true,
      });
      if (typeof navigator.userAgentData.getHighEntropyValues === 'function') {
        const originalGetHighEntropyValues = navigator.userAgentData.getHighEntropyValues.bind(navigator.userAgentData);
        navigator.userAgentData.getHighEntropyValues = function (hints) {
          return originalGetHighEntropyValues(hints).then(result => {
            const patched = { ...result };
            const hintList = Array.isArray(hints) ? hints : [];
            if (hintList.includes('uaFullVersion')) patched.uaFullVersion = '${CHROME_FULL}';
            if (hintList.includes('fullVersionList')) {
              patched.fullVersionList = chromeBrands.map(entry => ({
                ...entry,
                version: entry.brand === ' Not A Brand' ? '99' : '${CHROME_FULL}',
              }));
            }
            if (hintList.includes('model')) patched.model = '';
            if (hintList.includes('platformVersion')) patched.platformVersion = '${OS_PLATFORM_VERSION}';
            if (hintList.includes('architecture')) patched.architecture = '${ARCHITECTURE}';
            if (hintList.includes('bitness')) patched.bitness = '64';
            return patched;
          });
        };
      }
    }
  } catch (error) {}
  try {
    const needsPlugins = !navigator.plugins || navigator.plugins.length === 0;
    if (needsPlugins) {
      const pdfPlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      ];
      const buildPluginArray = () => {
        const arrayLike = {
          length: pdfPlugins.length,
          item: function (index) { return this[String(index)] || null; },
          namedItem: function (name) {
            for (const name_key in this) {
              if (this[name_key] && this[name_key].name === name) return this[name_key];
            }
            return null;
          },
          refresh: function () {},
        };
        pdfPlugins.forEach((plugin, index) => {
          arrayLike[String(index)] = plugin;
          arrayLike[plugin.name] = plugin;
        });
        return arrayLike;
      };
      Object.defineProperty(navigator, 'plugins', {
        get: buildPluginArray,
        configurable: true,
      });
      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => ({
          length: 2,
          0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pdfPlugins[0] },
          1: { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pdfPlugins[0] },
          item: function (index) { return this[String(index)] || null; },
          namedItem: function (name) { return this[name] || null; },
          [Symbol.iterator]: function* () { yield this[0]; yield this[1]; },
        }),
        configurable: true,
      });
    }
  } catch (error) {}
})();
`;

function applyPatch() {
  webFrame.executeJavaScript(PATCH, false).catch(() => {});
}

// preload 随每次页面加载自动运行；SPA 路由共享同一 window（__vosChromePatched 保证只打一次）。
applyPatch();
