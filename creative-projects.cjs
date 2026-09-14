'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  ensureCreativeAssetRoot,
  normalizeRelativePath,
  validateFolderName,
} = require('./creative-assets.cjs');

const CREATIVE_PROJECTS_SCHEMA_VERSION = 1;
const INSPIRATION_PROJECT_ID = 'inspiration';
const INSPIRATION_PROJECT_NAME = '灵感生成';
const PROJECT_ID_PATTERN = /^(?:inspiration|project-[a-f0-9]{12}|project-[0-9a-f-]{20,})$/;
const PROJECT_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'characters', label: '人物资产', aliases: Object.freeze(['人物资产', '人物']) }),
  Object.freeze({ id: 'scenes', label: '场景资产', aliases: Object.freeze(['场景资产', '场景']) }),
  Object.freeze({ id: 'wardrobe-props', label: '服装与道具', aliases: Object.freeze(['服装与道具', '服装道具', '服装', '道具']) }),
  Object.freeze({ id: 'color-cards', label: '色卡', aliases: Object.freeze(['色卡']) }),
  Object.freeze({ id: 'audio', label: '音频', aliases: Object.freeze(['音频']) }),
  Object.freeze({ id: 'generated-images', label: '生成图片', aliases: Object.freeze(['生成图片']) }),
  Object.freeze({ id: 'generated-videos', label: '生成视频', aliases: Object.freeze(['生成视频']) }),
  Object.freeze({ id: 'finals', label: '成片', aliases: Object.freeze(['成片']) }),
  Object.freeze({
    id: 'frames',
    label: '首帧与尾帧',
    aliases: Object.freeze(['首帧与尾帧', '首尾帧']),
    children: Object.freeze(['首帧', '尾帧']),
  }),
  Object.freeze({ id: 'references', label: '视频参考', aliases: Object.freeze(['视频参考']) }),
  Object.freeze({ id: 'documents', label: '剧本与提示词', aliases: Object.freeze(['剧本与提示词', '剧本提示词']) }),
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value) {
  return String(value || '').normalize('NFC').trim();
}

function nameKey(value) {
  return normalizeName(value).toLocaleLowerCase('zh-CN');
}

function deterministicProjectId(folder) {
  const digest = crypto.createHash('sha256').update(nameKey(folder)).digest('hex').slice(0, 12);
  return `project-${digest}`;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeProjectFolder(value) {
  const folder = normalizeRelativePath(normalizeName(value));
  if (!folder || folder.includes('/')) throw new Error('剧本资产目录必须是创作资产库的一级文件夹');
  validateFolderName(folder);
  return folder;
}

function validateProject(value) {
  if (!isPlainObject(value)) throw new Error('剧本记录格式无效');
  const id = String(value.id || '').trim();
  if (!PROJECT_ID_PATTERN.test(id)) throw new Error('剧本 ID 格式无效');
  const name = normalizeName(value.name);
  validateFolderName(name);
  const folder = safeProjectFolder(value.folder || name);
  const kind = value.kind === 'inspiration' ? 'inspiration' : 'script';
  if (kind === 'inspiration' && id !== INSPIRATION_PROJECT_ID) throw new Error('灵感项目 ID 无效');
  if (id === INSPIRATION_PROJECT_ID && (kind !== 'inspiration' || folder !== INSPIRATION_PROJECT_NAME)) {
    throw new Error('灵感项目记录无效');
  }
  const createdAt = Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : nowIso();
  const updatedAt = Number.isFinite(Date.parse(value.updatedAt)) ? value.updatedAt : createdAt;
  return { id, name, folder, kind, createdAt, updatedAt };
}

function readDocument(filePath, onWarning) {
  if (!fs.existsSync(filePath)) return { version: CREATIVE_PROJECTS_SCHEMA_VERSION, activeProjectId: '', projects: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isPlainObject(parsed) || parsed.version !== CREATIVE_PROJECTS_SCHEMA_VERSION || !Array.isArray(parsed.projects)) {
      throw new Error('配置版本或字段无效');
    }
    const projects = parsed.projects.map(validateProject);
    const ids = new Set();
    const folders = new Set();
    for (const project of projects) {
      if (ids.has(project.id)) throw new Error(`剧本 ID 重复：${project.id}`);
      const folderKey = nameKey(project.folder);
      if (folders.has(folderKey)) throw new Error(`剧本目录重复：${project.folder}`);
      ids.add(project.id);
      folders.add(folderKey);
    }
    const activeProjectId = ids.has(String(parsed.activeProjectId || '')) ? String(parsed.activeProjectId) : '';
    return { version: CREATIVE_PROJECTS_SCHEMA_VERSION, activeProjectId, projects };
  } catch (error) {
    onWarning?.(`剧本注册表读取失败，已使用目录重新建立索引：${error.message}`);
    return { version: CREATIVE_PROJECTS_SCHEMA_VERSION, activeProjectId: '', projects: [] };
  }
}

function writeDocument(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = `${JSON.stringify(document, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, payload, { encoding: 'utf-8', flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function createCreativeProjectStore(options = {}) {
  const filePath = path.resolve(String(options.filePath || ''));
  const assetRoot = path.resolve(String(options.assetRoot || ''));
  if (!options.filePath || !path.isAbsolute(options.filePath)) throw new Error('剧本注册表必须使用绝对路径');
  if (!options.assetRoot || !path.isAbsolute(options.assetRoot)) throw new Error('创作资产库必须使用绝对路径');
  if (assetRoot === path.parse(assetRoot).root) throw new Error('拒绝把磁盘根目录作为创作资产库');
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : () => {};
  ensureCreativeAssetRoot(assetRoot);

  let document = readDocument(filePath, onWarning);

  const commit = next => {
    writeDocument(filePath, next);
    document = next;
  };

  const discoverFolders = () => {
    let entries = [];
    try { entries = fs.readdirSync(assetRoot, { withFileTypes: true }); } catch {}
    return entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
      .map(entry => normalizeName(entry.name))
      .filter(Boolean);
  };

  const reconcile = ({ persist = true } = {}) => {
    const projects = [...document.projects];
    const knownFolders = new Set(projects.map(project => nameKey(project.folder)));
    let changed = false;
    for (const folder of discoverFolders()) {
      if (knownFolders.has(nameKey(folder))) continue;
      const inspiration = folder === INSPIRATION_PROJECT_NAME;
      projects.push({
        id: inspiration ? INSPIRATION_PROJECT_ID : deterministicProjectId(folder),
        name: folder,
        folder,
        kind: inspiration ? 'inspiration' : 'script',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      knownFolders.add(nameKey(folder));
      changed = true;
    }
    if (!projects.some(project => project.id === INSPIRATION_PROJECT_ID)) {
      const createdAt = nowIso();
      projects.push({
        id: INSPIRATION_PROJECT_ID,
        name: INSPIRATION_PROJECT_NAME,
        folder: INSPIRATION_PROJECT_NAME,
        kind: 'inspiration',
        createdAt,
        updatedAt: createdAt,
      });
      changed = true;
    }
    let activeProjectId = document.activeProjectId;
    if (!projects.some(project => project.id === activeProjectId)) {
      activeProjectId = projects.find(project => project.folder === '青春校园短剧' && project.kind === 'script')?.id
        || projects.find(project => project.kind === 'script')?.id
        || INSPIRATION_PROJECT_ID;
      changed = true;
    }
    if (changed) {
      const next = { version: CREATIVE_PROJECTS_SCHEMA_VERSION, activeProjectId, projects };
      if (persist) commit(next); else document = next;
    }
    return changed;
  };

  const projectById = id => document.projects.find(project => project.id === String(id || '')) || null;
  const projectExists = project => {
    if (!project) return false;
    try {
      const absolute = path.join(assetRoot, project.folder);
      const stat = fs.lstatSync(absolute);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  };

  const ensureStructure = project => {
    if (!project) throw new Error('剧本不存在');
    const root = path.join(assetRoot, project.folder);
    if (!projectExists(project)) fs.mkdirSync(root, { recursive: false });
    const entries = new Map(
      fs.readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.'))
        .map(entry => [nameKey(entry.name), entry.name]),
    );
    const categories = [];
    for (const definition of PROJECT_CATEGORIES) {
      const existing = definition.aliases.map(alias => entries.get(nameKey(alias))).find(Boolean);
      const folder = existing || definition.label;
      const absolute = path.join(root, folder);
      if (!existing) fs.mkdirSync(absolute);
      const children = [];
      for (const child of definition.children || []) {
        const childAbsolute = path.join(absolute, child);
        if (!fs.existsSync(childAbsolute)) fs.mkdirSync(childAbsolute);
        children.push({ label: child, path: `${project.folder}/${folder}/${child}` });
      }
      categories.push({
        id: definition.id,
        label: definition.label,
        folder,
        path: `${project.folder}/${folder}`,
        children,
      });
    }
    return categories;
  };

  const publicProject = project => ({
    ...project,
    available: projectExists(project),
    active: project.id === document.activeProjectId,
    categories: projectExists(project) ? ensureStructure(project) : [],
  });

  reconcile();
  ensureStructure(projectById(INSPIRATION_PROJECT_ID));
  const initialActive = projectById(document.activeProjectId);
  if (initialActive) ensureStructure(initialActive);

  return Object.freeze({
    schemaVersion: CREATIVE_PROJECTS_SCHEMA_VERSION,
    categories: PROJECT_CATEGORIES.map(({ id, label }) => ({ id, label })),
    list() {
      reconcile();
      return [...document.projects]
        .sort((a, b) => Number(a.kind !== 'inspiration') - Number(b.kind !== 'inspiration')
          || b.updatedAt.localeCompare(a.updatedAt)
          || a.name.localeCompare(b.name, 'zh-CN'))
        .map(publicProject);
    },
    get(id) {
      reconcile();
      const project = projectById(id);
      return project ? publicProject(project) : null;
    },
    active() {
      reconcile();
      const project = projectById(document.activeProjectId) || projectById(INSPIRATION_PROJECT_ID);
      return project ? publicProject(project) : null;
    },
    findByName(name) {
      reconcile();
      const key = nameKey(name);
      const project = document.projects.find(item => nameKey(item.name) === key || nameKey(item.folder) === key);
      return project ? publicProject(project) : null;
    },
    create(input = {}) {
      reconcile();
      const name = normalizeName(input.name);
      validateFolderName(name);
      if (nameKey(name) === nameKey(INSPIRATION_PROJECT_NAME)) throw new Error('“灵感生成”是系统工作区');
      if (document.projects.some(project => nameKey(project.name) === nameKey(name) || nameKey(project.folder) === nameKey(name))) {
        const error = new Error('同名剧本已经存在');
        error.code = 'PROJECT_EXISTS';
        throw error;
      }
      const absolute = path.join(assetRoot, name);
      if (fs.existsSync(absolute)) throw new Error('创作资产库中已经存在同名文件夹');
      fs.mkdirSync(absolute);
      const createdAt = nowIso();
      const project = {
        id: `project-${crypto.randomUUID()}`,
        name,
        folder: name,
        kind: 'script',
        createdAt,
        updatedAt: createdAt,
      };
      try {
        ensureStructure(project);
        commit({
          version: CREATIVE_PROJECTS_SCHEMA_VERSION,
          activeProjectId: project.id,
          projects: [...document.projects, project],
        });
      } catch (error) {
        try {
          const entries = fs.readdirSync(absolute);
          if (!entries.length) fs.rmdirSync(absolute);
        } catch {}
        throw error;
      }
      return publicProject(project);
    },
    ensure(input = {}) {
      const name = normalizeName(input.name);
      const key = nameKey(name);
      reconcile();
      const existing = document.projects.find(item => nameKey(item.name) === key || nameKey(item.folder) === key);
      if (existing) return publicProject(existing);
      validateFolderName(name);
      if (nameKey(name) === nameKey(INSPIRATION_PROJECT_NAME)) return publicProject(projectById(INSPIRATION_PROJECT_ID));
      const absolute = path.join(assetRoot, name);
      if (fs.existsSync(absolute)) {
        reconcile();
        const discovered = document.projects.find(item => nameKey(item.folder) === key);
        if (discovered) return publicProject(discovered);
      }
      const createdAt = nowIso();
      fs.mkdirSync(absolute);
      const project = {
        id: `project-${crypto.randomUUID()}`,
        name,
        folder: name,
        kind: 'script',
        createdAt,
        updatedAt: createdAt,
      };
      ensureStructure(project);
      commit({
        version: CREATIVE_PROJECTS_SCHEMA_VERSION,
        activeProjectId: project.id,
        projects: [...document.projects, project],
      });
      return publicProject(project);
    },
    activate(id) {
      reconcile();
      const project = projectById(id);
      if (!project) throw new Error('剧本不存在或已移出创作资产库');
      ensureStructure(project);
      const updated = { ...project, updatedAt: nowIso() };
      commit({
        version: CREATIVE_PROJECTS_SCHEMA_VERSION,
        activeProjectId: updated.id,
        projects: document.projects.map(item => item.id === updated.id ? updated : item),
      });
      return publicProject(updated);
    },
    resolveRoot(id) {
      const project = projectById(id || document.activeProjectId);
      if (!project) throw new Error('剧本不存在');
      ensureStructure(project);
      return path.join(assetRoot, project.folder);
    },
    category(id, categoryId) {
      const project = projectById(id || document.activeProjectId);
      if (!project) throw new Error('剧本不存在');
      const category = ensureStructure(project).find(item => item.id === categoryId);
      if (!category) throw new Error('剧本资产分类不存在');
      return { ...category, absolutePath: path.join(assetRoot, ...category.path.split('/')) };
    },
    snapshot() {
      return {
        schemaVersion: CREATIVE_PROJECTS_SCHEMA_VERSION,
        activeProjectId: document.activeProjectId,
        projects: this.list(),
        categories: this.categories,
      };
    },
  });
}

module.exports = {
  CREATIVE_PROJECTS_SCHEMA_VERSION,
  INSPIRATION_PROJECT_ID,
  INSPIRATION_PROJECT_NAME,
  PROJECT_CATEGORIES,
  createCreativeProjectStore,
};
