'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// 单视频置顶浮窗专用 preload：只暴露「读取当前置顶视频信息」「把这一个视频原生拖出」
// 「关闭浮窗」「标题栏拖动兜底」四项能力，全部走固定通道、不传任意路径给主进程执行。
// 渲染层拿不到 fs/path/ipcRenderer 本身，也拿不到素材绝对路径 —— 预览用同源 URL。
// 主进程每次都按当前剧本重新校验：切剧本后旧视频既读不到也拖不出。
contextBridge.exposeInMainWorld('floatVideoAPI', Object.freeze({
  getInfo: () => ipcRenderer.invoke('float-video:get-info'),
  onPrepare: callback => subscribe('float-video:prepare', callback),
  onPresent: callback => subscribe('float-video:present', callback),
  onSettled: callback => subscribe('float-video:settled', callback),
  readyToPresent: id => ipcRenderer.send('float-video:ready', id),
  settlePresentation: id => ipcRenderer.send('float-video:settle', id),
  startAssetDrag: relativePath => ipcRenderer.send('float:start-asset-drag', {
    path: relativePath && typeof relativePath === 'object' ? relativePath.path : relativePath,
  }),
  onDragResult: callback => subscribe('float:drag-result', callback),
  closeWindow: () => ipcRenderer.send('float:close'),
  moveWindow: (dx, dy) => ipcRenderer.send('float:move-window', { dx, dy }),
}));
