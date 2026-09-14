'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 两个工作页面共用宿主窗口，IPC 在主进程按当前页面校验。
contextBridge.exposeInMainWorld('desktopOS', Object.freeze({
  isElectron: true,
  openCreatorBrowser: request => ipcRenderer.invoke('os:open-creator', request),
  addMediaSource: kind => ipcRenderer.invoke('os:add-media-source', kind),
  removeMediaSource: sourceId => ipcRenderer.invoke('os:remove-media-source', sourceId),
  onOpenProjectPicker: callback => subscribe('os:open-project-picker', callback),
  onDownloadComplete: callback => subscribe('os:download-complete', callback),
}));

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('creatorAPI', Object.freeze({
  automation: (name, args = {}) => ipcRenderer.invoke('creator:automation', { name, arguments: args }),
  getConfig: () => ipcRenderer.invoke('creator:get-config'),
  addCustomService: service => ipcRenderer.invoke('creator:add-custom-service', service),
  renameService: (serviceId, name) => ipcRenderer.invoke('creator:rename-service', { serviceId, name }),
  renameTab: (tabId, name) => ipcRenderer.invoke('creator:rename-tab', { tabId, name }),
  removeCustomService: serviceId => ipcRenderer.invoke('creator:remove-custom-service', serviceId),
  removeService: serviceId => ipcRenderer.invoke('creator:remove-service', serviceId),
  restoreBuiltinService: serviceId => ipcRenderer.invoke('creator:restore-builtin-service', serviceId),
  restoreBuiltinServices: () => ipcRenderer.invoke('creator:restore-builtin-services'),
  setAssetPanel: patch => ipcRenderer.invoke('creator:set-asset-panel', patch),
  focusAssetInLibrary: (assetPath, projectId) => ipcRenderer.invoke('asset:focus-asset', { path: assetPath, projectId }),
  toggleDragTray: () => ipcRenderer.invoke('creator:toggle-drag-tray'),
  selectService: (serviceId, mode) => ipcRenderer.invoke('creator:select-service', { serviceId, mode }),
  setMode: (mode, serviceId) => ipcRenderer.invoke('creator:set-mode', { mode, serviceId }),
  openTab: (serviceId, mode, afterTabId) => ipcRenderer.invoke('creator:open-tab', { serviceId, mode, afterTabId }),
  selectTab: tabId => ipcRenderer.invoke('creator:select-tab', { tabId }),
  closeTab: tabId => ipcRenderer.invoke('creator:close-tab', { tabId }),
  clearTabs: () => ipcRenderer.invoke('creator:clear-tabs'),
  setBrowserBounds: bounds => ipcRenderer.invoke('creator:set-browser-bounds', bounds),
  navigate: action => ipcRenderer.invoke('creator:navigate', action),
  navigateUrl: address => ipcRenderer.invoke('creator:navigate-url', address),
  openExternal: () => ipcRenderer.invoke('creator:open-external'),
  importFiles: mode => ipcRenderer.invoke('creator:import-files', mode),
  importAssets: () => ipcRenderer.invoke('creator:import-assets'),
  getPathForFile: file => webUtils.getPathForFile(file),
  importDroppedAssets: payload => ipcRenderer.invoke('creator:import-dropped-assets', payload),
  copyAsset: assetPath => ipcRenderer.invoke('creator:copy-creative-asset', { path: assetPath }),
  startAssetDrag: assetPath => ipcRenderer.send('creator:start-asset-drag', { path: assetPath }),
  startAssetDragSelection: paths => ipcRenderer.send('creator:start-asset-drag', { paths }),
  onAssetDragResult: callback => subscribe('creator:asset-drag-result', callback),
  deleteAsset: assetPath => ipcRenderer.invoke('creator:delete-creative-asset', { path: assetPath }),
  pageZoom: action => ipcRenderer.invoke('creator:page-zoom', { action }),
  setPlatformViewHidden: hidden => ipcRenderer.invoke('creator:set-platform-view-hidden', { hidden }),
  openFolder: kind => ipcRenderer.invoke('creator:open-folder', kind),
  openDownload: downloadId => ipcRenderer.invoke('creator:open-download', downloadId),
  downloadAction: (downloadId, action) => ipcRenderer.invoke('creator:download-action', { downloadId, action }),
  focusBrowser: () => ipcRenderer.invoke('creator:focus-browser'),
  showMainWindow: () => ipcRenderer.invoke('creator:show-main-window'),
  showProjectPicker: mode => ipcRenderer.invoke('creator:show-project-picker', mode),
  showProjectMenu: options => ipcRenderer.invoke('creator:show-project-menu', options),
  getDownloads: () => ipcRenderer.invoke('creator:get-downloads'),
  onBrowserState: callback => subscribe('creator:browser-state', callback),
  onDownload: callback => subscribe('creator:download', callback),
  onSetMode: callback => subscribe('creator:set-mode', callback),
  onProjectChanged: callback => subscribe('creator:project-changed', callback),
  onAssetPanelState: callback => subscribe('creator:asset-panel-state', callback),
}));
