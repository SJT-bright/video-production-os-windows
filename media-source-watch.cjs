'use strict';

const fs = require('node:fs');

// 只监听用户已经登记的目录；离线盘重新挂载、目录新增或取消关联时同步监听。
function createMediaSourceWatcher({ store, onChange, intervalMs = 4000 }) {
  const watchers = new Map();
  let interval, debounce, signature = '';
  const notify = () => {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 600);
  };
  function refresh() {
    const sources = store.list().filter(source => !source.builtIn && source.available);
    const ids = new Set(sources.map(source => source.id));
    for (const [id, entry] of watchers) {
      if (!ids.has(id)) { entry.watcher?.close(); watchers.delete(id); notify(); }
    }
    for (const source of sources) {
      if (watchers.has(source.id)) continue;
      const entry = { watcher: null };
      try {
        entry.watcher = fs.watch(store.directory(source.id), { recursive: true }, notify);
        entry.watcher.on('error', () => { entry.watcher?.close(); entry.watcher = null; notify(); });
      } catch { /* 不支持递归监听的文件系统使用下方指纹轮询。 */ }
      watchers.set(source.id, entry);
      notify();
    }
    if ([...watchers.values()].some(entry => !entry.watcher)) {
      const next = store.scan().files.filter(file => ids.has(file.sourceId))
        .map(file => `${file.sourceId}/${file.relativePath}:${file.size}:${file.mtime}`).join('\n');
      if (signature && signature !== next) notify();
      signature = next;
    }
  }
  return {
    refresh,
    start() { refresh(); interval = setInterval(refresh, intervalMs); interval.unref?.(); },
    stop() { clearInterval(interval); clearTimeout(debounce); for (const entry of watchers.values()) entry.watcher?.close(); watchers.clear(); },
  };
}

module.exports = { createMediaSourceWatcher };
