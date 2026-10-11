'use strict';

// 独立原生子窗口：网页 WebContentsView 不会覆盖分类选项，网络下载也不被对话框阻塞。
function createDownloadReviewUI({ BrowserWindow, ipcMain, parent, url, preload, onError }) {
  let queue = Promise.resolve(), current = null, stopped = false;
  const cancelled = new Set();
  ipcMain.handle('download-review:get-info', event => {
    if (!current || event.sender !== current.win.webContents) throw new Error('下载分类窗口已关闭');
    return { filename: current.record.filename, projectName: current.record.projectName || '当前剧本' };
  });
  ipcMain.on('download-review:choose', (event, choice) => {
    if (!current || event.sender !== current.win.webContents || !['editable', 'processing', 'cancel'].includes(choice)) return;
    current.finish(choice);
  });
  const open = record => new Promise(resolve => {
    if (stopped) { resolve('defer'); return; }
    if (cancelled.delete(record.id)) { resolve('cancel'); return; }
    const owner = parent();
    if (!owner || owner.isDestroyed()) { resolve('defer'); return; }
    const win = new BrowserWindow({
      parent: owner, modal: true, width: 560, height: 332, useContentSize: true, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, show: false,
      title: '选择视频分类', backgroundColor: '#f8f9fc',
      webPreferences: { preload, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
    });
    let finished = false;
    const finish = choice => {
      if (finished) return;
      finished = true;
      if (current?.win === win) current = null;
      resolve(choice);
      if (!win.isDestroyed()) win.destroy();
    };
    current = { win, record, finish };
    win.once('closed', () => finish(stopped || owner.isDestroyed() ? 'defer' : 'cancel'));
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.loadURL(url()).catch(error => { onError?.(error); finish('defer'); });
  });
  return Object.freeze({
    choose(record) {
      const request = queue.then(() => open(record));
      queue = request.catch(() => {});
      return request;
    },
    cancel(id) { if (current?.record.id === id) current.finish('cancel'); else cancelled.add(id); },
    stop() { stopped = true; current?.finish('defer'); },
  });
}
module.exports = { createDownloadReviewUI };
