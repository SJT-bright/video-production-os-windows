'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 剪映拖拽助手悬浮窗专用：原生拖拽（单文件 {path} / 多文件 {paths}，与资产面板同一 main 侧通道族）、
// 文件复制到系统剪贴板（剪映 ⌘V 粘贴，多文件按给定顺序）、窗口关闭。
contextBridge.exposeInMainWorld('trayAPI', Object.freeze({
  startDrag: relativePath => ipcRenderer.send('tray:start-asset-drag', { path: relativePath }),
  startDragSelection: paths => ipcRenderer.send('tray:start-asset-drag', { paths }),
  onDragResult: callback => subscribe('tray:drag-result', callback),
  closeTray: () => ipcRenderer.send('tray:close'),
}));
