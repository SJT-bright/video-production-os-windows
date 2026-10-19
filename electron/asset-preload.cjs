'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('assetAPI', Object.freeze({
  automation: (name, args = {}) => ipcRenderer.invoke('creator:automation', { name, arguments: args }),
  getConfig: () => ipcRenderer.invoke('asset:get-config'),
  getDownloadEpisodes: () => ipcRenderer.invoke('asset:get-download-episodes'),
  advanceDownloadEpisode: payload => ipcRenderer.invoke('asset:advance-download-episode', payload),
  selectDownloadEpisode: payload => ipcRenderer.invoke('asset:select-download-episode', payload),
  setPanelState: patch => ipcRenderer.invoke('asset:set-panel-state', patch),
  startDrag: relativePath => ipcRenderer.send('asset:start-drag', { path: relativePath }),
  // 多选整批拖出：{paths} 数组按选入顺序整批发送，主进程共享 startAssetDrag 展开为原生多文件拖动（同悬浮窗语义）
  startDragSelection: paths => ipcRenderer.send('asset:start-drag', { paths }),
  copyImage: relativePath => ipcRenderer.invoke('asset:copy-image', { path: relativePath }),
  showItem: relativePath => ipcRenderer.invoke('asset:show-item', { path: relativePath }),
  saveAudioAs: relativePath => ipcRenderer.invoke('creator:export-audio', { path: relativePath }),
  deleteItem: relativePath => ipcRenderer.invoke('asset:delete-item', { path: relativePath }),
  deleteItems: payload => ipcRenderer.invoke('asset:delete-items', payload),
  showFolderMenu: payload => ipcRenderer.invoke('asset:folder-menu', payload),
  renameFolder: payload => ipcRenderer.invoke('asset:rename-folder', payload),
  openLibrary: () => ipcRenderer.invoke('asset:open-library'),
  showProjectPicker: () => ipcRenderer.invoke('asset:show-project-picker'),
  pickSourceFolder: () => ipcRenderer.invoke('asset:pick-source-folder'),
  onPanelState: callback => subscribe('asset:panel-state', callback),
  onDownloadEpisodesChanged: callback => subscribe('asset:download-episodes-changed', callback),
  onDragResult: callback => subscribe('asset:drag-result', callback),
  onFocusAsset: callback => subscribe('asset:focus-asset', callback),
  consumePendingFocus: () => ipcRenderer.invoke('asset:consume-pending-focus'),
}));
