'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { setImmediate: yieldToMainLoop } = require('node:timers/promises');

const TECHNICAL_DIRECTORIES = new Set(['.git', '.worktrees', 'node_modules', 'test-artifacts']);
const DOCUMENT_EXTENSIONS = new Set(['.md', '.txt', '.srt']);

function documentGroup(name, relativePath) {
  if (/^VIDEO-\d+_/.test(name)) return 'distill';
  if (/^TOOL-\d+_/.test(name)) return 'tool';
  if (name === 'AGENTS.md' || name === 'MEMORY-MANIFEST.md') return 'system';
  return relativePath.includes('/') ? null : 'manual';
}

// The local HTTP server also runs in Electron's main process. Directory I/O must
// yield to native input, and packaged apps must not scan their own source/builds.
async function scanProjectDocuments({ root, excludedRoots = [], maxEntries = 50000, maxDepth = 32 }) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    throw new Error('项目文档扫描边界无效');
  }
  const base = path.resolve(root);
  const excluded = new Set(excludedRoots.map(value => path.resolve(value)));
  const files = [];
  const limits = { maxEntries, maxDepth, entries: 0, directories: 0, readErrors: 0, truncated: false };
  let exhausted = false;
  const queue = [{ absolute: base, relative: '', depth: 0 }];
  for (let index = 0; index < queue.length && !exhausted; index++) {
    const directory = queue[index];
    let handle;
    try { handle = await fs.opendir(directory.absolute); }
    catch { limits.readErrors++; continue; }
    limits.directories++;
    try {
      for await (const entry of handle) {
        if (limits.entries >= maxEntries) { limits.truncated = true; exhausted = true; break; }
        limits.entries++;
        if (limits.entries % 128 === 0) await yieldToMainLoop();
        if (entry.isSymbolicLink()) continue;
        const absolute = path.join(directory.absolute, entry.name);
        const relative = directory.relative ? `${directory.relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const name = entry.name.toLowerCase();
          if (excluded.has(absolute) || TECHNICAL_DIRECTORIES.has(name) || /\.(app|framework)$/i.test(name)) continue;
          if (directory.depth >= maxDepth) { limits.truncated = true; continue; }
          queue.push({ absolute, relative, depth: directory.depth + 1 });
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!entry.isFile() || !DOCUMENT_EXTENSIONS.has(ext)) continue;
        const group = documentGroup(entry.name, relative);
        if (!group) continue;
        let stat;
        try { stat = await fs.lstat(absolute); }
        catch { limits.readErrors++; continue; }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        files.push({ path: relative, name: entry.name, ext, type: 'doc', group,
          size: stat.size, mtime: stat.mtime.toISOString(),
          hidden: relative.split('/').some(part => part.startsWith('.')) });
      }
    } catch { limits.readErrors++; }
  }
  return { files, limits };
}

module.exports = { scanProjectDocuments, documentGroup };
