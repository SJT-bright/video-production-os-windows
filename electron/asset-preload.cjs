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
  setPanelState: patch => ipcRenderer.invoke('asset:set-panel-state', patch),
  startDrag: relativePath => ipcRenderer.send('asset:start-drag', { path: relativePath }),
  copyImage: relativePath => ipcRenderer.invoke('asset:copy-image', { path: relativePath }),
  showItem: relativePath => ipcRenderer.invoke('asset:show-item', { path: relativePath }),
  deleteItem: relativePath => ipcRenderer.invoke('asset:delete-item', { path: relativePath }),
  openLibrary: () => ipcRenderer.invoke('asset:open-library'),
  showProjectPicker: () => ipcRenderer.invoke('asset:show-project-picker'),
  pickSourceFolder: () => ipcRenderer.invoke('asset:pick-source-folder'),
  onPanelState: callback => subscribe('asset:panel-state', callback),
  onDragResult: callback => subscribe('asset:drag-result', callback),
  onFocusAsset: callback => subscribe('asset:focus-asset', callback),
  consumePendingFocus: () => ipcRenderer.invoke('asset:consume-pending-focus'),
}));
