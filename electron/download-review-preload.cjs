'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('downloadReviewAPI', Object.freeze({
  getInfo: () => ipcRenderer.invoke('download-review:get-info'),
  choose: choice => ipcRenderer.send('download-review:choose', choice),
}));
