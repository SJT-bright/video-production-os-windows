'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 标签右键菜单小窗专用：只收主进程推送的条目，回传点选动作、关闭请求与内容尺寸；
// 不暴露任何文件、浏览器或系域能力。消失时机（驻留 500ms / 淡出 120ms）由主进程裁决。
contextBridge.exposeInMainWorld('TabMenuAPI', Object.freeze({
  onShow: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('tab-menu:show', listener);
    return () => ipcRenderer.removeListener('tab-menu:show', listener);
  },
  pick: id => ipcRenderer.send('tab-menu:pick', { id }),
  dismiss: () => ipcRenderer.send('tab-menu:dismiss'),
  reportSize: (width, height) => ipcRenderer.send('tab-menu:report-size', { width, height }),
}));
