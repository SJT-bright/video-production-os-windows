'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopOS', Object.freeze({
  isElectron: true,
  getAppReleaseState: () => ipcRenderer.invoke('support:get-state'),
  checkAppUpdates: () => ipcRenderer.invoke('support:check-updates'),
  openGitHubStar: () => ipcRenderer.invoke('support:open-star'),
  openAppRelease: () => ipcRenderer.invoke('support:open-release'),
  onAppReleaseState: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('support:update-state', listener);
    return () => ipcRenderer.removeListener('support:update-state', listener);
  },
  openCreatorBrowser: request => ipcRenderer.invoke('os:open-creator', request),
  addMediaSource: kind => ipcRenderer.invoke('os:add-media-source', kind),
  removeMediaSource: sourceId => ipcRenderer.invoke('os:remove-media-source', sourceId),
  onOpenProjectPicker: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('os:open-project-picker', listener);
    return () => ipcRenderer.removeListener('os:open-project-picker', listener);
  },
  onDownloadComplete: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('os:download-complete', listener);
    return () => ipcRenderer.removeListener('os:download-complete', listener);
  },
}));
