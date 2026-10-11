(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PromptTemplateStore = factory();
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const GLOBAL_KEY = 'videoOS.creator.global.v2';
  const PROJECT_PREFIX = 'videoOS.creator.project.v2.';
  const MODES = ['image', 'video'];
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  function projectKey(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('剧本标识无效');
    return PROJECT_PREFIX + id;
  }
  function read(storage, key) {
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const value = JSON.parse(raw);
    if (!isObject(value)) throw new Error('工作区保存记录无效，未修改原数据');
    return value;
  }
  function valid(items) {
    return (Array.isArray(items) ? items : []).filter(item => isObject(item)
      && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.body === 'string');
  }
  const originalTitle = item => item.title === item.migrationGeneratedTitle && typeof item.migrationOriginalTitle === 'string'
    ? item.migrationOriginalTitle : item.title;
  const identity = item => JSON.stringify([originalTitle(item), item.body]);
  const newId = () => 'prompt-' + (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2));
  function append(existing, source, makeId = newId) {
    const result = existing.map(item => ({ ...item }));
    const exact = new Set(result.flatMap(item => [identity(item), JSON.stringify([item.title, item.body])]));
    const names = new Set(result.map(item => item.title));
    const ids = new Set(result.map(item => item.id));
    let added = 0, skipped = 0;
    for (const item of source) {
      const key = identity(item);
      if (exact.has(key)) { skipped++; continue; }
      let title = item.title;
      for (let number = 2; names.has(title); number++) {
        const suffix = `（${number}）`;
        title = item.title.slice(0, 40 - suffix.length) + suffix;
      }
      let id;
      do { id = makeId(); } while (ids.has(id));
      result.push({ ...item, id, title, migrationOriginalTitle: originalTitle(item), migrationGeneratedTitle: title });
      exact.add(key); names.add(title); ids.add(id); added++;
    }
    return { items: result, added, skipped };
  }
  function create(storage) {
    return Object.freeze({
      // 旧全局模板只绑定升级时当前剧本；保留原全局记录，不再自动复制给新剧本。
      // 标记先落地：项目写入失败时，所属剧本仍能从原记录恢复，其他剧本不会误领。
      claimLegacy(projectId) {
        projectKey(projectId);
        const global = read(storage, GLOBAL_KEY);
        if (!global.templateLegacyOwnerProjectId && isObject(global.templates)) {
          storage.setItem(GLOBAL_KEY, JSON.stringify({ ...global, templateLegacyOwnerProjectId: projectId }));
        }
      },
      load(projectId, legacy = null) {
        const project = read(storage, projectKey(projectId));
        const global = read(storage, GLOBAL_KEY);
        const templates = {};
        for (const mode of MODES) {
          // 已初始化项目允许空列表；删除的模板不能被旧全局备份再次补回。
          if (project.promptTemplatesVersion === 3) templates[mode] = valid(project.promptTemplates?.[mode]).map(item => ({ ...item }));
          else {
            const own = valid(project.promptTemplates?.[mode] || legacy?.promptTemplates?.[mode]);
            const inherited = global.templateLegacyOwnerProjectId === projectId ? valid(global.templates?.[mode]) : [];
            templates[mode] = append(own, inherited).items;
          }
        }
        return templates;
      },
      migrate(sourceProjectId, targetProjectId) {
        if (sourceProjectId === targetProjectId) throw new Error('请选择另一个目标剧本');
        const source = this.load(sourceProjectId);
        const target = this.load(targetProjectId);
        const previous = read(storage, projectKey(targetProjectId));
        const templates = {}, counts = { image: 0, video: 0 }, skipped = { image: 0, video: 0 };
        for (const mode of MODES) {
          const merged = append(target[mode], source[mode]);
          templates[mode] = merged.items; counts[mode] = merged.added; skipped[mode] = merged.skipped;
        }
        const added = counts.image + counts.video;
        // 两种模式一次提交；失败时目标原有模板、草稿、剧本和历史完全不变。
        if (added) storage.setItem(projectKey(targetProjectId), JSON.stringify({
          ...previous, promptTemplatesVersion: 3, promptTemplates: templates,
        }));
        return { templates, counts, skipped, added };
      },
    });
  }
  return Object.freeze({ create, GLOBAL_KEY, PROJECT_PREFIX });
});
