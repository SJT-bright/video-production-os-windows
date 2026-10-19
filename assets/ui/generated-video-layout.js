(function (root, factory) {
  'use strict';
  const layout = factory();
  if (typeof module === 'object' && module.exports) module.exports = layout;
  else root.GeneratedVideoLayout = layout;
})(globalThis, function () {
  'use strict';
  const PREFIX = 'videoOS-generated://';
  const HISTORY_PREFIX = 'videoOS-history://';
  const UNASSIGNED = '未分集素材';
  const OLD_UNASSIGNED = '未分集历史素材';
  const statusNames = ['可剪辑', '待处理'];
  const within = (value, parent) => value === parent || value.startsWith(parent + '/');
  const episode = value => /^第([1-9]\d{0,5})集$/.test(value || '');
  const date = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match) return false;
    const [year, month, day] = match.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  };
  const isVirtualPath = value => String(value || '').startsWith(PREFIX) || String(value || '').startsWith(HISTORY_PREFIX);

  // A projection, not a filesystem migration. Every asset keeps its original
  // path/folderPath; displayFolderPath is used only for drawing the two trees.
  function organize({ folders, assets, project, batch }) {
    const result = { folders, assets, members: new Map(), aliases: new Map() };
    const category = project?.categories?.find(item => item.id === 'generated-videos');
    if (!category?.path || batch?.projectId !== project?.id || !Array.isArray(batch.states)) return result;
    const realFolders = new Map(folders.map(folder => [folder.node.path, folder]));
    const categoryFolder = realFolders.get(category.path);
    if (!categoryFolder) return result;
    const entries = new Map();
    for (const entry of batch.states) {
      const platform = entry?.platformFolder;
      if (entry?.kind !== 'video' || entry.available !== true || entry.projectId !== project.id
        || typeof platform !== 'string' || !platform || /[\\/]/.test(platform) || platform === '.' || platform === '..'
        || statusNames.includes(platform) || entry.platformPath !== category.path + '/' + platform) continue;
      entries.set(entry.platformPath, entry);
    }
    const markUnclassified = rows => rows.map(folder => {
      if (folder.generatedVideoGroup) return folder;
      const parent = folder.parentPath;
      if (parent !== category.path && !statusNames.some(status => parent === category.path + '/' + status)) return folder;
      return { ...folder, archiveUnclassified: true,
        explanation: '未归类的真实目录；未识别到可靠网站归档身份，保留原目录和文件，可手动整理' };
    });
    if (!entries.size) { result.folders = markUnclassified(folders); return result; }
    const removed = new Set(), added = [], displayFolders = new Map();
    const fileByPath = new Map(assets.map(asset => [asset.path, asset]));
    const displayAssets = assets.map(asset => ({ ...asset }));
    for (const [site, entry] of entries) {
      const legacyLabels = [...new Set([entry.platformFolder, entry.serviceLabel].filter(label => typeof label === 'string'
        && label && !/[\\/]/.test(label) && label !== '.' && label !== '..' && !statusNames.includes(label)))];
      const sources = [site, ...statusNames.flatMap(status => legacyLabels.map(label => category.path + '/' + status + '/' + label))]
        .filter(source => realFolders.has(source));
      if (!sources.length) continue; // Never invent empty websites from config.
      const groups = new Map(), backings = new Map();
      const add = (parts, parentParts = null) => {
        const conceptual = [site, ...parts].join('/');
        if (groups.has(conceptual)) return groups.get(conceptual);
        const parent = parentParts === null ? null : add(parentParts, parentParts.length ? parentParts.slice(0, -1) : null);
        const historical = parts[0] === UNASSIGNED;
        const physical = backings.get(conceptual);
        const real = (!historical && realFolders.get(conceptual))
          || (parts.length >= 3 && physical?.size === 1 && realFolders.get([...physical][0]));
        const key = real ? real.node.path : parts.length === 1 && historical
          ? HISTORY_PREFIX + encodeURIComponent(site) : PREFIX + encodeURIComponent(conceptual);
        const group = { node: { kind: 'folder', name: parts.at(-1) || entry.platformFolder, path: key, fileCount: 0, children: [] },
          depth: parent ? parent.depth + 1 : categoryFolder.depth + 1,
          parentPath: parent ? parent.node.path : category.path, hasChildren: true,
          generatedVideoGroup: true, virtualGenerated: !real, fixedOrder: parts.length > 0 && parts.length < 3,
          canonicalPath: site, actionPath: real?.node?.path || '',
          backingPaths: parts.length === 0 ? [...sources] : [...new Set([...(real ? [real.node.path] : []), ...(physical || [])])],
          explanation: real ? '' : '只读展示分组；原文件未搬动，请选择真实集目录存入，或对具体素材操作',
          ...(parts.length === 0 ? { downloadEpisode: entry } : {}),
          ...(parts.length === 1 && historical ? { virtualHistory: true, legacyParent: site } : {}),
          assetPaths: new Set(), displayPath: conceptual };
        groups.set(conceptual, group); displayFolders.set(key, group); added.push(group);
        // A persisted aggregate selection must survive the first import or
        // episode advance creating its canonical physical directory.
        result.aliases.set(PREFIX + encodeURIComponent(conceptual), key);
        if (historical) result.aliases.set(PREFIX + encodeURIComponent([site, OLD_UNASSIGNED, ...parts.slice(1)].join('/')), key);
        result.members.set(key, group.assetPaths);
        return group;
      };
      const partsFor = (rawPath, source, statusOverride = '') => {
        let parts = rawPath.slice(source.length).split('/').filter(Boolean);
        const first = parts.shift();
        const group = episode(first) ? [first] : [UNASSIGNED];
        if (!episode(first) && first && !date(first)) parts.unshift(first);
        const legacyStatus = source === site ? '' : source.split('/').at(-2);
        const explicitStatus = statusNames.includes(parts[0]) ? parts.shift() : '';
        const status = statusOverride || legacyStatus || explicitStatus || '可剪辑';
        return [...group, status, ...parts];
      };
      for (const source of sources) {
        for (const folder of folders) {
          if (folder.node.path === source || !within(folder.node.path, source)) continue;
          const parts = partsFor(folder.node.path, source);
          if (parts.length < 2) continue;
          const conceptual = [site, ...parts].join('/');
          const paths = backings.get(conceptual) || new Set(); paths.add(folder.node.path); backings.set(conceptual, paths);
        }
      }
      const siteGroup = add([]);
      for (const source of sources) {
        result.aliases.set(source, siteGroup.node.path);
        for (const folder of folders) {
          if (!within(folder.node.path, source)) continue;
          removed.add(folder.node.path);
          if (folder.node.path === source) continue;
          const relative = folder.node.path.slice(source.length + 1);
          // Empty real episode directories are intentional next-episode targets.
          if (source === site && episode(relative)) {
            result.aliases.set(folder.node.path, add([relative], []).node.path);
          } else if (source === site) {
            const segments = relative.split('/');
            if (segments.length === 2 && episode(segments[0]) && statusNames.includes(segments[1])) {
              // Actual status directories keep their identity even if a direct
              // file has old metadata. Do not invent a missing sibling.
              result.aliases.set(folder.node.path, add(segments, [segments[0]]).node.path);
            }
          }
        }
        for (const asset of displayAssets) {
          if (!within(asset.folderPath || '', source)) continue;
          const status = asset.videoDisposition === 'processing' ? '待处理' : asset.videoDisposition === 'editable' ? '可剪辑' : '';
          const parts = partsFor(asset.folderPath || source, source, status);
          let leaf = siteGroup;
          for (let index = 1; index <= parts.length; index++) leaf = add(parts.slice(0, index), parts.slice(0, index - 1));
          asset.displayFolderPath = leaf.node.path;
          // A real website/episode is a browsing and import identity, not the
          // status of whichever direct file happened to be processed last.
          if (!result.aliases.has(asset.folderPath)) result.aliases.set(asset.folderPath, leaf.node.path);
          let current = leaf;
          while (current) {
            current.assetPaths.add(asset.path);
            current = displayFolders.get(current.parentPath);
          }
        }
        // Retain unknown empty custom folders rather than guessing their purpose.
        for (const folder of folders) {
          if (folder.node.path === source || !within(folder.node.path, source) || folder.node.fileCount) continue;
          const parts = partsFor(folder.node.path, source);
          // Only structural wrappers may disappear. A real empty custom folder
          // below an episode/status/date must remain visible and writable.
          if (parts.length < 3) continue;
          let group;
          for (let index = 1; index <= parts.length; index++) group = add(parts.slice(0, index), parts.slice(0, index - 1));
          result.aliases.set(folder.node.path, group.node.path);
        }
        for (const folder of folders) {
          if (folder.node.path === source || !within(folder.node.path, source) || result.aliases.has(folder.node.path)) continue;
          const conceptual = [site, ...partsFor(folder.node.path, source)].join('/');
          const group = groups.get(conceptual) || groups.get(site + '/' + UNASSIGNED) || siteGroup;
          result.aliases.set(folder.node.path, group.node.path);
        }
      }
    }
    // Remove obsolete top-level status wrappers only when all their actual
    // contents were incorporated. Unknown/custom content remains accessible.
    for (const status of statusNames) {
      const key = category.path + '/' + status;
      if (!realFolders.has(key)) continue;
      const remainingFolder = folders.some(folder => folder.node.path !== key && within(folder.node.path, key) && !removed.has(folder.node.path));
      const looseFile = assets.some(asset => asset.folderPath === key);
      if (!remainingFolder && !looseFile) { removed.add(key); result.aliases.set(key, category.path); }
    }
    for (const folder of added) {
      folder.node.fileCount = folder.assetPaths.size;
      // A combined website is not the same deletion scope as a physical folder.
      folder.composite = !folder.virtualGenerated && [...folder.assetPaths].some(token => !within(fileByPath.get(token)?.folderPath || '', folder.node.path));
      folder.capabilities = { create: !!folder.actionPath, reveal: !!folder.actionPath,
        rename: !!folder.actionPath, delete: !!folder.actionPath && !folder.composite };
      if (folder.composite) folder.explanation = '汇总多个真实位置；目录操作只作用于真实主目录，不代表删除整组素材';
    }
    result.folders = markUnclassified([...folders.filter(folder => !removed.has(folder.node.path)), ...added]);
    result.assets = displayAssets;
    return result;
  }
  return Object.freeze({ organize, isVirtualPath, unassignedLabel: UNASSIGNED });
});
