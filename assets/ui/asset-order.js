(function (root, factory) {
  'use strict';
  const order = factory();
  if (typeof module === 'object' && module.exports) module.exports = order;
  else root.AssetOrder = order;
})(globalThis, function () {
  'use strict';

  // 日期目录是生成日期，不受旧的手动文件夹顺序或文件名中的日期影响。
  function dateFolderKey(name) {
    const text = String(name || '');
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return '';
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] ? text : '';
  }

  function directoryDate(folderPath) {
    const parts = String(folderPath || '').replace(/\\/g, '/').split('/');
    for (let index = parts.length - 1; index >= 0; index--) {
      const date = dateFolderKey(parts[index]);
      if (date) return date;
    }
    return '';
  }

  function timestamp(item) {
    for (const value of [item?.mtime, item?.endedAt, item?.createdAt, item?.startedAt]) {
      const time = typeof value === 'number' ? value : Date.parse(value);
      if (Number.isFinite(time)) return time;
    }
    return 0;
  }

  function assetDateKey(item) {
    if (item?.folderPath) {
      const date = directoryDate(item.folderPath);
      if (date) return date;
    }
    for (const value of [item?.relativePath, item?.displayPath, item?.path]) {
      const folder = String(value || '').replace(/\\/g, '/').split('/').slice(0, -1).join('/');
      const date = directoryDate(folder);
      if (date) return date;
    }
    const time = timestamp(item);
    if (!time) return '';
    const local = new Date(time);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  }

  function newestFirst(a, b) {
    return assetDateKey(b).localeCompare(assetDateKey(a))
      || timestamp(b) - timestamp(a)
      || String(b?.name || '').localeCompare(String(a?.name || ''), 'zh-CN', { numeric: true });
  }

  // 只有普通分类使用手动顺序；日期槽位始终从新到旧，不删除用户保存的分类顺序。
  function orderFolders(entries, savedOrder) {
    const node = entry => entry.node || entry;
    const isDate = entry => Boolean(dateFolderKey(node(entry).name));
    const ranks = new Map((Array.isArray(savedOrder) ? savedOrder : []).map((path, index) => [path, index]));
    const ordinary = entries.filter(entry => !isDate(entry)).sort((a, b) =>
      (ranks.get(node(a).path) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(node(b).path) ?? Number.MAX_SAFE_INTEGER));
    const dates = entries.filter(isDate).sort((a, b) => node(b).name.localeCompare(node(a).name));
    let ordinaryIndex = 0, dateIndex = 0;
    return entries.map(entry => isDate(entry) ? dates[dateIndex++] : ordinary[ordinaryIndex++]);
  }

  function compareFolderPaths(a, b) {
    const left = String(a || '').replace(/\\/g, '/').split('/');
    const right = String(b || '').replace(/\\/g, '/').split('/');
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] === right[index]) continue;
      const leftDate = dateFolderKey(left[index]), rightDate = dateFolderKey(right[index]);
      if (leftDate && rightDate) return right[index].localeCompare(left[index]);
      if (leftDate || rightDate) return leftDate ? -1 : 1;
      return left[index].localeCompare(right[index], 'zh-CN', { numeric: true });
    }
    return left.length - right.length;
  }

  return Object.freeze({ dateFolderKey, directoryDate, assetDateKey, newestFirst, orderFolders, compareFolderPaths });
});
