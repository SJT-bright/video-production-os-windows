'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('WorkspaceMenuAPI', Object.freeze({
  onShow: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workspace-menu:show', listener);
    return () => ipcRenderer.removeListener('workspace-menu:show', listener);
  },
  pick: payload => ipcRenderer.send('workspace-menu:pick', payload),
  dismiss: token => ipcRenderer.send('workspace-menu:dismiss', { token }),
  reportSize: payload => ipcRenderer.send('workspace-menu:report-size', payload),
}));
