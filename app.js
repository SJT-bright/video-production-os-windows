/* ================= 视频制作 OS · 主程序 ================= */
'use strict';

/* ---------- 工具 ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1800);
}

async function copyText(text) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      copied = document.execCommand('copy');
      ta.remove();
    } catch {}
  }
  toast(copied ? '已复制到剪贴板' : '复制失败，请手动复制');
  return copied;
}

async function requestJson(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error('无法连接本地服务器');
  }
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error((data && data.error) || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = data && data.code || '';
    throw error;
  }
  return data;
}

function errorView(message, retry) {
  return h('div', { class: 'empty-tip error-view', role: 'alert' },
    h('div', {}, message),
    retry ? h('button', { class: 'btn small', onclick: retry }, '重试') : null,
  );
}

const fileUrl = relPath => `/api/file?p=${encodeURIComponent(relPath)}`;
const obsidianFileUrl = relPath => `/api/obsidian/file?p=${encodeURIComponent(relPath)}`;
const TYPE_NAME = { video: '视频', image: '图片', audio: '音频', doc: '文案' };
const ROOT_FOLDER = '（根目录）';

async function openAssetFolder() {
  try {
    const data = await requestJson('/api/open-asset-folder');
    toast(data.ok ? '已打开素材库文件夹' : (data.message || '当前系统不支持打开文件夹'));
  } catch (error) {
    toast('打开素材库失败：' + error.message);
  }
}

const MediaImporter = {
  active: null,
  choose(kind, onComplete) {
    if (this.active) { toast('已有文件正在导入'); return; }
    const input = h('input', {
      type: 'file',
      multiple: 'multiple',
      accept: kind === 'audio'
        ? '.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus,.wma,.aiff,.aif,.amr,.ape,audio/*'
        : '.mp4,.mov,.webm,.mkv,.avi,.m4v,video/*',
      class: 'hidden',
    });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (files.length) this.run(files, kind, onComplete);
    }, { once: true });
    input.addEventListener('cancel', () => input.remove(), { once: true });
    document.body.appendChild(input);
    input.click();
  },
  upload(file, kind, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const endpoint = `/api/import-media?kind=${encodeURIComponent(kind)}&name=${encodeURIComponent(file.name)}`;
      xhr.open('POST', endpoint);
      xhr.responseType = 'json';
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.addEventListener('progress', event => {
        if (event.lengthComputable) onProgress(event.loaded, event.total);
      });
      xhr.addEventListener('load', () => {
        const payload = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(new Error(payload.error || `导入失败（HTTP ${xhr.status}）`));
      });
      xhr.addEventListener('error', () => reject(new Error('文件传输中断，请重试')));
      xhr.addEventListener('abort', () => reject(Object.assign(new Error('已取消导入'), { name: 'AbortError' })));
      this.active.xhr = xhr;
      xhr.send(file);
    });
  },
  async run(files, kind, onComplete) {
    const heading = h('strong', {}, kind === 'audio' ? '正在导入音频' : '正在导入视频');
    const detail = h('span', {}, `准备导入 ${files.length} 个文件`);
    const progress = h('progress', { max: '100', value: '0', 'aria-label': '文件导入进度' });
    const count = h('span', { class: 'media-import-count' }, `0 / ${files.length}`);
    const cancel = h('button', { class: 'btn small' }, '取消');
    const panel = h('section', { class: 'media-import-panel', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'media-import-copy' }, heading, detail),
      progress,
      count,
      cancel,
    );
    document.body.appendChild(panel);
    this.active = { xhr: null, cancelled: false, panel };
    cancel.addEventListener('click', () => {
      this.active.cancelled = true;
      this.active.xhr?.abort();
      cancel.disabled = true;
      detail.textContent = '正在取消…';
    });

    let imported = 0;
    const failures = [];
    for (let index = 0; index < files.length && !this.active.cancelled; index++) {
      const file = files[index];
      detail.textContent = `${file.name} · ${fmtBytes(file.size)}`;
      count.textContent = `${index + 1} / ${files.length}`;
      progress.value = 0;
      try {
        await this.upload(file, kind, (loaded, total) => {
          progress.value = total ? Math.round(loaded / total * 100) : 0;
          detail.textContent = `${file.name} · ${fmtBytes(loaded)} / ${fmtBytes(total)}`;
        });
        imported++;
      } catch (error) {
        if (error.name === 'AbortError') break;
        failures.push(`${file.name}：${error.message}`);
      }
    }

    this.active.xhr = null;
    cancel.disabled = true;
    if (imported) {
      heading.textContent = `已导入 ${imported} 个文件`;
      detail.textContent = failures.length ? `${failures.length} 个文件失败，可重新选择导入` : '素材索引已自动刷新';
      progress.value = 100;
      try { await onComplete?.(); } catch (error) { failures.push(`刷新索引：${error.message}`); }
    } else if (this.active.cancelled) {
      heading.textContent = '导入已取消';
      detail.textContent = '未完成的临时文件已清理';
    } else {
      heading.textContent = '没有文件导入成功';
      detail.textContent = failures[0] || '请选择受支持的媒体文件';
    }
    if (failures.length) panel.title = failures.join('\n');
    this.active = null;
    setTimeout(() => panel.remove(), 3200);
  },
};

/* 五星评分控件：点击打分，再点同一颗清零 */
function ratingWidget(current, onSet) {
  const wrap = h('div', { class: 'rating-widget', title: '点击评分（再点同一颗清零）' });
  const render = v => {
    wrap.replaceChildren();
    for (let i = 1; i <= 5; i++) {
      wrap.appendChild(h('button', {
        class: 'rw-star' + (i <= v ? ' on' : ''),
        onclick: async () => {
          const next = i === v ? 0 : i;
          render(next);
          try { await onSet(next); } catch (err) { toast('评分保存失败：' + err.message); render(v); }
        },
      }, '★'));
    }
  };
  render(current || 0);
  return wrap;
}

function topFolderOf(path) {
  return path.includes('/') ? path.split('/')[0] : ROOT_FOLDER;
}

function parentFolderOf(path) {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ROOT_FOLDER;
}

function fmtBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function fmtDur(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

function sortAssets(files, mode) {
  const sorted = [...files];
  sorted.sort((a, b) => {
    if (mode === 'oldest') return a.mtime.localeCompare(b.mtime);
    if (mode === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (mode === 'size') return b.size - a.size || a.name.localeCompare(b.name, 'zh-CN');
    if (mode === 'folder') return parentFolderOf(a.displayPath || a.path).localeCompare(parentFolderOf(b.displayPath || b.path), 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN');
    return b.mtime.localeCompare(a.mtime);
  });
  return sorted;
}

/* ---------- Markdown 渲染 ---------- */
function renderMD(text, container) {
  container.classList.add('md-body');
  const rendered = document.createElement('div');
  rendered.innerHTML = marked.parse(text || '（空文档）');
  rendered.querySelectorAll('script,style,iframe,object,embed,form,base,meta,link,button,input,textarea,select,svg,math')
    .forEach(el => el.remove());
  rendered.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'style') {
        el.removeAttribute(attr.name);
      } else if (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name) &&
        /^(javascript|vbscript|data:text\/html):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    });
    if (el.tagName === 'A' && /^https?:\/\//i.test(el.getAttribute('href') || '')) {
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    }
  });
  container.innerHTML = rendered.innerHTML;
  // 标题加锚点 + 生成大纲用
  let i = 0;
  $$('h1,h2,h3,h4', container).forEach(head => {
    head.id = 'hd-' + (++i);
  });
  // 代码块加复制按钮
  $$('pre', container).forEach(pre => {
    const btn = h('button', { class: 'copy-code-btn', title: '复制代码块' }, '复制');
    btn.addEventListener('click', () => copyText(pre.innerText.replace(/^复制\n?/, '')));
    pre.appendChild(btn);
  });
}

/* ---------- 数据仓库 ---------- */
const Store = {
  scan: null,
  knowledge: null,

  async loadScan(force) {
    if (this.scan && !force) return this.scan;
    const data = await requestJson('/api/scan');
    if (!data || !data.counts || !Array.isArray(data.files) || !Array.isArray(data.docs)) {
      throw new Error('扫描数据格式无效');
    }
    this.scan = data;
    this.updateChips();
    return this.scan;
  },
  async loadKnowledge(force) {
    if (this.knowledge && !force) return this.knowledge;
    const data = await requestJson('/api/knowledge');
    if (!data || !Array.isArray(data.sections)) throw new Error('经验库数据格式无效');
    this.knowledge = data;
    return this.knowledge;
  },

  async loadObsidianNotes(force) {
    if (this.obsidianNotes && !force) return this.obsidianNotes;
    const data = await requestJson('/api/obsidian/tree');
    if (!data || !data.available || !data.tree) { this.obsidianNotes = []; return this.obsidianNotes; }
    const notes = [];
    const walk = node => {
      for (const child of node.children || []) {
        if (child.kind === 'note') notes.push({ name: child.name.replace(/\.md$/i, ''), path: child.path });
        else if (child.kind === 'folder') walk(child);
      }
    };
    walk(data.tree);
    this.obsidianNotes = notes;
    return notes;
  },
  async saveKnowledge() {
    return requestJson('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.knowledge),
    });
  },
  async setMeta(path, patch) {
    const data = await requestJson('/api/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...patch }),
    });
    if (!data || !data.item) throw new Error('素材标记保存失败');
    const f = this.scan && this.scan.files.find(x => x.path === path);
    if (f) f.meta = data.item;
    return data.item;
  },
  updateChips() {
    if (!this.scan) return;
    const c = { video: 0, image: 0, audio: 0, doc: 0 };
    this.scan.files.forEach(f => { if (c[f.type] !== undefined) c[f.type]++; });
    const chips = $('#tbChips');
    if (chips) {
      chips.innerHTML =
        `<span class="tb-chip">视频 <b>${c.video}</b></span>` +
        `<span class="tb-chip">图片 <b>${c.image}</b></span>` +
        `<span class="tb-chip">音频 <b>${c.audio}</b></span>` +
        `<span class="tb-chip">蒸馏文档 <b>${this.scan.docs.filter(d => d.group === 'distill').length}</b></span>`;
    }
    const iconSubs = {
      assets: `${c.video + c.image} 项媒体`,
      audio: `${c.audio} 条音频`,
      distill: `${this.scan.docs.length} 份文档`,
      finals: `${this.scan.files.filter(f => !f.hidden && f.type === 'video' && f.meta && f.meta.isFinal === true && !f.meta.rejected).length} 条成片`,

    };
    $$('[data-app-count]').forEach(el => {
      const text = iconSubs[el.dataset.appCount];
      if (text) el.textContent = text.replace(/\D+/g, '') || '0';
    });
    const health = $('#indexHealth');
    const lastScan = $('#lastScan');
    if (health) {
      const sources = Array.isArray(this.scan.sources) ? this.scan.sources : [];
      const connected = this.scan.assetAvailable || sources.some(source => source.available !== false);
      health.textContent = connected ? '本地索引已连接' : '媒体来源均离线';
    }
    if (lastScan) lastScan.textContent = `扫描于 ${fmtDate(this.scan.scannedAt)}`;
  },
};

/* ---------- 图标 ---------- */
const ICONS = Object.freeze({
  assets: UIIcons.html('media-index'),
  creativeAssets: UIIcons.html('library'),
  creator: UIIcons.html('studio'),
  script: UIIcons.html('document'),
  agent: UIIcons.html('sparkle'),
  distill: UIIcons.html('knowledge'),
  obsidian: UIIcons.html('obsidian'),
  film: UIIcons.html('film'),
  video: UIIcons.html('video'),
  image: UIIcons.html('image'),
  audio: UIIcons.html('audio'),
  doc: UIIcons.html('document'),
  overview: UIIcons.html('overview'),
  projects: UIIcons.html('film'),
  help: UIIcons.html('help'),
  import: UIIcons.html('import'),
});
// 注入渐变 defs
(function injectGradients() {
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  defs.setAttribute('width', '0'); defs.setAttribute('height', '0');
  defs.style.position = 'absolute';
  defs.innerHTML = '<defs><linearGradient id="gA" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#c05e4a"/><stop offset="1" stop-color="#4a6b9c"/></linearGradient></defs>';
  document.body.prepend(defs);
})();

/* ---------- 窗口管理器 ---------- */
const LAYOUT_KEY = 'vos.layout.v1';

const WM = {
  zTop: 100,
  windows: new Map(), // appId -> win state
  layer: null,
  savedLayout: null,
  _layoutTimer: null,
  init() {
    this.layer = $('#windowsLayer');
    this.savedLayout = this.readLayout();
    // 分屏吸附提示层
    this.snapHint = h('div', { id: 'snapHint', class: 'hidden' });
    this.layer.appendChild(this.snapHint);
  },
  readLayout() {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      const data = raw ? JSON.parse(raw) : null;
      return (data && typeof data === 'object' && typeof data.windows === 'object') ? data : null;
    } catch { return null; }
  },
  saveLayout() {
    const data = { open: [], windows: {} };
    this.windows.forEach((w, id) => {
      data.open.push(id);
      data.windows[id] = {
        left: w.el.style.left, top: w.el.style.top,
        width: w.el.style.width, height: w.el.style.height,
        max: w.el.classList.contains('maximized'),
        hidden: w.el.classList.contains('hidden'),
        z: parseInt(w.el.style.zIndex) || 0,
      };
    });
    this.savedLayout = data;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(data)); } catch {}
  },
  saveLayoutSoon() {
    clearTimeout(this._layoutTimer);
    this._layoutTimer = setTimeout(() => this.saveLayout(), 400);
  },
  isOpen(appId) { return this.windows.has(appId); },
  open(appId) {
    if (this.windows.has(appId)) {
      const w = this.windows.get(appId);
      w.el.classList.remove('hidden');
      this.focus(appId);
      this.updateDock();
      this.saveLayout();
      return w;
    }
    const app = APPS[appId];
    if (!app) return null;
    const el = $('#tplWindow').content.firstElementChild.cloneNode(true);
    const area = this.layer.getBoundingClientRect();
    const width = Math.min(app.width || 860, area.width - 40);
    const height = Math.min(app.height || 560, area.height - 90);
    const offset = (this.windows.size % 6) * 26;
    el.style.width = width + 'px';
    el.style.height = height + 'px';
    el.style.left = Math.max(10, Math.min(120 + offset, area.width - width - 10)) + 'px';
    el.style.top = Math.max(6, Math.min(46 + offset, area.height - height - 10)) + 'px';
    // 恢复上次会话的窗口位置与尺寸（限制在可视区内）
    const saved = this.savedLayout && this.savedLayout.windows[appId];
    if (saved) {
      const w = Math.min(parseInt(saved.width) || width, area.width - 16);
      const h = Math.min(parseInt(saved.height) || height, area.height - 16);
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.left = Math.max(0, Math.min(parseInt(saved.left) || 120, Math.max(0, area.width - 100))) + 'px';
      el.style.top = Math.max(0, Math.min(parseInt(saved.top) || 46, Math.max(0, area.height - 60))) + 'px';
      if (saved.max) el.classList.add('maximized');
    }
    el.querySelector('.win-icon').innerHTML = app.icon || ICONS.film;
    el.querySelector('.win-text').textContent = app.title;
    this.layer.appendChild(el);

    const win = { id: appId, el, app, state: {} };
    this.windows.set(appId, win);
    this.bindWinControls(win);
    app.mount(el.querySelector('.win-body'), win);
    this.focus(appId);
    this.updateDock();
    this.saveLayout();
    return win;
  },
  focus(appId) {
    const w = this.windows.get(appId);
    if (!w) return;
    w.el.style.zIndex = ++this.zTop;
    this.windows.forEach(other => other.el.classList.toggle('focused', other === w));
    this.saveLayoutSoon();
  },
  close(appId) {
    const w = this.windows.get(appId);
    if (!w) return;
    if (w.app.onClose) w.app.onClose(w);
    w.el.remove();
    this.windows.delete(appId);
    this.updateDock();
    this.saveLayout();
  },
  minimize(appId) {
    const w = this.windows.get(appId);
    if (!w) return;
    w.el.classList.add('hidden');
    this.updateDock();
    this.saveLayout();
  },
  toggleMax(appId) {
    const w = this.windows.get(appId);
    if (!w) return;
    w.el.classList.toggle('maximized');
    if (w.el.classList.contains('maximized')) {
      w.el.style.left = '0'; w.el.style.top = '0';
      w.el.style.width = '100%'; w.el.style.height = '100%';
    } else {
      w.el.style.left = w.prevLeft || '120px';
      w.el.style.top = w.prevTop || '46px';
      w.el.style.width = w.prevW || (w.app.width || 860) + 'px';
      w.el.style.height = w.prevH || (w.app.height || 560) + 'px';
    }
    this.saveLayout();
  },
  bindWinControls(win) {
    const el = win.el;
    el.addEventListener('pointerdown', () => this.focus(win.id));
    el.querySelector('.wc-close').addEventListener('click', () => this.close(win.id));
    el.querySelector('.wc-min').addEventListener('click', () => this.minimize(win.id));
    el.querySelector('.wc-max').addEventListener('click', () => this.toggleMax(win.id));

    const titlebar = el.querySelector('.win-titlebar');
    titlebar.addEventListener('pointerdown', e => {
      if (e.target.closest('.win-controls')) return;
      if (el.classList.contains('maximized')) return;
      const rect = el.getBoundingClientRect();
      const area = this.layer.getBoundingClientRect();
      const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
      el.classList.add('dragging');
      let snapZone = null;
      const showSnap = zone => {
        snapZone = zone;
        const hint = this.snapHint;
        if (!zone) { hint.classList.add('hidden'); return; }
        hint.classList.remove('hidden');
        if (zone === 'max') {
          hint.style.cssText = 'left:6px;top:6px;width:' + (area.width - 12) + 'px;height:' + (area.height - 12) + 'px';
        } else if (zone === 'left' || zone === 'right') {
          const w = Math.floor(area.width / 2) - 9;
          hint.style.cssText = (zone === 'left' ? 'left:6px;' : 'left:' + (Math.ceil(area.width / 2) + 3) + 'px;') +
            'top:6px;width:' + w + 'px;height:' + (area.height - 12) + 'px';
        }
      };
      const move = ev => {
        el.style.left = Math.max(-rect.width + 120, Math.min(ev.clientX - dx, area.width - 60)) + 'px';
        el.style.top = Math.max(0, Math.min(ev.clientY - dy, area.height - 40)) + 'px';
        // 靠近屏幕边缘时提示分屏吸附
        const edge = 14;
        let zone = null;
        if (ev.clientY - area.top <= edge) zone = 'max';
        else if (ev.clientX - area.left <= edge) zone = 'left';
        else if (area.right - ev.clientX <= edge) zone = 'right';
        if (zone !== snapZone) showSnap(zone);
      };
      const up = () => {
        el.classList.remove('dragging');
        win.prevLeft = el.style.left; win.prevTop = el.style.top;
        const zone = snapZone; // 先取吸附区，再清提示层
        showSnap(null);
        if (zone === 'max') {
          if (!el.classList.contains('maximized')) this.toggleMax(win.id);
        } else if (zone === 'left' || zone === 'right') {
          const half = Math.floor(area.width / 2);
          el.style.left = (zone === 'left' ? 0 : area.width - half) + 'px';
          el.style.top = '0px';
          el.style.width = half + 'px';
          el.style.height = area.height + 'px';
          win.prevLeft = el.style.left; win.prevTop = el.style.top;
          win.prevW = el.style.width; win.prevH = el.style.height;
        }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.saveLayout();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    titlebar.addEventListener('dblclick', e => {
      if (!e.target.closest('.win-controls')) this.toggleMax(win.id);
    });

    const rz = el.querySelector('.win-resize');
    rz.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      el.classList.add('resizing');
      const move = ev => {
        el.style.width = Math.max(380, rect.width + ev.clientX - e.clientX) + 'px';
        el.style.height = Math.max(260, rect.height + ev.clientY - e.clientY) + 'px';
        win.prevW = el.style.width; win.prevH = el.style.height;
      };
      const up = () => {
        el.classList.remove('resizing');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        this.saveLayout();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    // 记录还原位置
    const obs = new MutationObserver(() => {
      if (!el.classList.contains('maximized')) {
        win.prevLeft = el.style.left; win.prevTop = el.style.top;
        win.prevW = el.style.width; win.prevH = el.style.height;
      }
    });
    obs.observe(el, { attributes: true, attributeFilter: ['style'] });
  },
  updateDock() {
    $$('.dock-item[data-app]').forEach(btn => {
      btn.classList.toggle('active', this.windows.has(btn.dataset.app) &&
        !this.windows.get(btn.dataset.app).el.classList.contains('hidden'));
    });
  },
};

/* ---------- 固定应用壳路由（替代桌面窗口） ---------- */
const SHELL_ROUTE_KEY = 'vos.route.v3';
Object.assign(WM, {
  activeId: null,
  init() {
    this.layer = $('#windowsLayer');
    this.windows = new Map();
    this.savedLayout = this.readLayout();
  },
  readLayout() {
    try {
      const active = localStorage.getItem(SHELL_ROUTE_KEY);
      return active ? { active } : null;
    } catch { return null; }
  },
  saveLayout() {
    try { localStorage.setItem(SHELL_ROUTE_KEY, this.activeId || 'creator'); } catch {}
  },
  saveLayoutSoon() { this.saveLayout(); },
  isOpen(appId) { return this.windows.has(appId); },
  open(appId) {
    if (!APPS[appId]) return null;
    let win = this.windows.get(appId);
    if (!win) {
      const app = APPS[appId];
      const el = $('#tplWindow').content.firstElementChild.cloneNode(true);
      el.dataset.app = appId;
      el.querySelector('.win-icon').innerHTML = app.icon || ICONS.film;
      el.querySelector('.win-text').textContent = app.title;
      this.layer.appendChild(el);
      win = { id: appId, el, app, state: {} };
      this.windows.set(appId, win);
      app.mount(el.querySelector('.win-body'), win);
    }
    this.focus(appId);
    return win;
  },
  focus(appId) {
    const win = this.windows.get(appId);
    if (!win) return;
    this.activeId = appId;
    this.windows.forEach((other, id) => {
      other.el.classList.toggle('hidden', id !== appId);
      other.el.classList.toggle('focused', id === appId);
      other.el.setAttribute('aria-hidden', id === appId ? 'false' : 'true');
    });
    const pageTitle = $('#pageTitle');
    const pageEyebrow = $('#pageEyebrow');
    const pageSubtitle = $('#pageSubtitle');
    if (pageTitle) pageTitle.textContent = win.app.pageTitle || win.app.title;
    if (pageEyebrow) pageEyebrow.textContent = win.app.eyebrow || 'VIDEO PRODUCTION OS';
    if (pageSubtitle) pageSubtitle.textContent = win.app.subtitle || '本机制作数据与项目文件实时同步';
    this.updateDock();
    this.saveLayout();
    closeSidebar();
    requestAnimationFrame(() => win.el.focus({ preventScroll: true }));
  },
  close(appId) {
    const win = this.windows.get(appId);
    if (!win) return;
    if (win.app.onClose) win.app.onClose(win);
    win.el.remove();
    this.windows.delete(appId);
    if (this.activeId === appId) this.open('creator');
  },
  minimize() { this.open('creator'); },
  toggleMax() {},
  bindWinControls() {},
  updateDock() {
    $$('.side-nav-item[data-app]').forEach(btn => {
      const selected = btn.dataset.app === this.activeId;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-current', selected ? 'page' : 'false');
    });
  },
});

/* ---------- 应用：素材库 ---------- */
const LibraryView = {
  importFiles(kind, projectId) {
    if (!projectId || ['all', 'unassigned'].includes(projectId)) { toast('请先选择音频或视频所属的剧本'); return; }
    const input = h('input', { type: 'file', accept: kind === 'audio' ? 'audio/*,.mp3,.wav,.m4a' : 'video/*', multiple: '' });
    input.addEventListener('change', async () => {
      let count = 0;
      const failed = [];
      for (const file of input.files || []) {
        try {
          await requestJson('/api/library-import?' + new URLSearchParams({ project: projectId, kind, name: file.name }),
            { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
          count++;
        } catch (error) { failed.push(error.message); }
      }
      await refreshMediaLibraries().catch(error => failed.push(error.message));
      toast(failed.length ? `已导入 ${count} 项；${failed[0]}` : `已导入 ${count} 项，保存在所选剧本`);
    });
    input.click();
  },
  projectKey(file) { return file.projectId || 'unassigned'; },
  select(value, onChange) {
    return h('select', { class: 'field', 'aria-label': '按剧本筛选', onchange: event => onChange(event.target.value) },
      h('option', { value: 'all', selected: value === 'all' ? '' : null }, '全部剧本'),
      ...(Store.scan?.projects || []).map(project => h('option', { value: project.id, selected: value === project.id ? '' : null }, project.name)),
      h('option', { value: 'unassigned', selected: value === 'unassigned' ? '' : null }, '未归属'),
    );
  },
  groups(files, renderFile, gridClass) {
    const groups = new Map();
    files.forEach(file => {
      const key = this.projectKey(file);
      if (!groups.has(key)) groups.set(key, { name: file.projectName || '未归属', files: [] });
      groups.get(key).files.push(file);
    });
    return [...groups.entries()].sort(([a], [b]) => a === 'unassigned' ? 1 : b === 'unassigned' ? -1 : 0).map(([key, group]) =>
      h('details', { class: 'library-project-group', open: '', 'data-project': key },
        h('summary', {}, h('strong', {}, group.name), h('span', {}, `${group.files.length} 项`)),
        h('div', { class: gridClass }, ...group.files.map(renderFile)),
      ));
  },
  async configure(purpose = 'media', selectedId = '') {
    try { await Store.loadScan(true); } catch (error) { toast(error.message); return; }
    const sources = (Store.scan.sources || []).filter(source => source.id !== 'creative-assets');
    const selected = sources.find(source => source.id === selectedId);
    const dialog = h('dialog', { class: 'library-source-dialog' });
    const project = h('select', { class: 'field', 'aria-label': '归属剧本' },
      h('option', { value: '' }, '请选择归属剧本'),
      ...(Store.scan.projects || []).map(item => h('option', { value: item.id, selected: item.id === selected?.projectId ? '' : null }, item.name)));
    const sourceSelect = h('select', { class: 'field', 'aria-label': '索引文件夹' },
      h('option', { value: '' }, '新增文件夹'),
      ...sources.map(source => h('option', { value: source.id, selected: source.id === selectedId ? '' : null }, source.label)));
    const usage = h('select', { class: 'field', 'aria-label': '目录用途' },
      h('option', { value: 'media', selected: (selected?.purpose || purpose) === 'media' ? '' : null }, '普通素材'),
      h('option', { value: 'finals', selected: (selected?.purpose || purpose) === 'finals' ? '' : null }, '成片目录'));
    const folder = h('input', { class: 'field', placeholder: '粘贴文件夹完整路径，或使用下方选择按钮', 'aria-label': '文件夹完整路径' });
    const status = h('p', { class: 'library-source-status', role: 'status' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, '保存索引');
    const pick = h('button', { class: 'btn', type: 'button' }, '选择文件夹并关联');
    pick.hidden = !window.desktopOS?.addMediaSource;
    const remove = h('button', { class: 'btn', type: 'button' }, '停止索引');
    const sync = () => {
      const source = sources.find(item => item.id === sourceSelect.value);
      folder.hidden = !!source;
      pick.hidden = !!source || !window.desktopOS?.addMediaSource;
      remove.hidden = !source?.removable;
      if (source) { project.value = source.projectId || ''; usage.value = source.purpose || purpose; }
    };
    sourceSelect.addEventListener('change', sync);
    const commit = async usePicker => {
      if (usage.value === 'finals' && !project.value) { status.textContent = '请先选择成片的归属剧本'; return; }
      save.disabled = pick.disabled = true;
      try {
        let id = sourceSelect.value;
        if (usePicker) {
          const result = await window.desktopOS.addMediaSource('folder');
          if (result?.cancelled) return;
          id = result.id;
        }
        await requestJson('/api/library-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: id ? 'save' : 'add', id, rootPath: folder.value.trim(), projectId: project.value, purpose: usage.value }) });
        await refreshMediaLibraries();
        dialog.close();
        toast('文件夹索引已保存');
      } catch (error) { status.textContent = error.message; }
      finally { save.disabled = pick.disabled = false; }
    };
    const form = h('form', { onsubmit: event => { event.preventDefault(); commit(false); } },
      h('h2', {}, '文件夹索引'),
      h('label', {}, '文件夹', sourceSelect, folder),
      h('label', {}, '归属剧本', project),
      h('label', {}, '用途', usage),
      h('p', {}, '成片目录中的视频自动收录。停止索引只取消关联，保留原文件。'), status,
      h('div', { class: 'library-source-actions' }, pick, save, remove,
        h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, '取消')));
    pick.addEventListener('click', () => commit(true));
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await requestJson('/api/library-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', id: sourceSelect.value }) });
        await refreshMediaLibraries(); dialog.close(); toast('已停止索引，原文件保留');
      } catch (error) { status.textContent = error.message; }
      finally { remove.disabled = false; }
    });
    dialog.append(form); document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    sync(); dialog.showModal();
  },
};

const AssetsApp = {
  id: 'assets', title: '图片与视频', pageTitle: '图片与视频', eyebrow: 'ASSET CENTER', subtitle: '按剧本归属的统一媒体索引', icon: ICONS.assets, width: 940, height: 600,
  async mount(root, win) {
    const S = win.state;
    S.filter = 'all'; S.source = 'all'; S.project = 'all'; S.query = ''; S.showHidden = false; S.sort = 'newest';
    S.tag = ''; S.selected = new Set(); S.lastSelIndex = -1;
    root.replaceChildren(h('div', { class: 'assets-app' },
      S.collections = h('div', { class: 'asset-collections' }),
      S.toolbar = h('div', { class: 'assets-toolbar' }),
      S.selbar = h('div', { class: 'sel-bar hidden' }),
      S.grid = h('div', { class: 'assets-grid' }),
    ));
    try {
      await Store.loadScan();
    } catch (err) {
      root.replaceChildren(errorView('素材扫描失败：' + err.message, () => this.mount(root, win)));
      return;
    }
    this.buildCollections(root, win);
    this.buildToolbar(root, win);
    this.render(root, win);
  },
  buildCollections(root, win) {
    const S = win.state;
    S.collections.replaceChildren(
      LibraryView.select(S.project || 'all', value => { S.project = value; this.render(root, win); }),
      h('button', { class: 'btn small', onclick: () => LibraryView.configure() }, '管理文件夹索引'),
    );
  },
  async addSource(kind, root, win) {
    if (!window.desktopOS?.addMediaSource) { toast('请在 Mac 桌面版中添加媒体目录'); return; }
    try {
      const result = await window.desktopOS.addMediaSource(kind);
      if (result?.cancelled) return;
      await Store.loadScan(true);
      this.buildCollections(root, win); this.buildToolbar(root, win); this.render(root, win);
      toast(`已开始索引 ${result?.label || '新目录'}`);
    } catch (error) { toast(`目录添加失败：${error.message}`); }
  },
  async removeSource(source, root, win) {
    if (!window.desktopOS?.removeMediaSource) return;
    if (!confirm(`停止索引「${source.label}」？不会删除目录中的任何文件。`)) return;
    try {
      await window.desktopOS.removeMediaSource(source.id);
      if (win.state.source === source.id) win.state.source = 'all';
      await Store.loadScan(true);
      this.buildCollections(root, win); this.buildToolbar(root, win); this.render(root, win);
      toast(`已停止索引 ${source.label}`);
    } catch (error) { toast(`停止索引失败：${error.message}`); }
  },
  buildToolbar(root, win) {
    const S = win.state;
    const scan = Store.scan;
    const allMedia = scan.files.filter(f => ['video', 'image'].includes(f.type));
    const alive = allMedia.filter(f => !(f.meta && f.meta.rejected));
    const visibleFiles = alive.filter(f => S.showHidden || !f.hidden);
    const rejectedCount = allMedia.filter(f => f.meta && f.meta.rejected).length;
    const chips = [
      ['all', `全部 ${visibleFiles.length}`],
      ['video', `视频 ${visibleFiles.filter(f => f.type === 'video').length}`],
      ['image', `图片 ${visibleFiles.filter(f => f.type === 'image').length}`],
      ['final', `成品 ${alive.filter(f => f.meta && f.meta.isFinal === true).length}`],
      ['starred', `收藏 ${alive.filter(f => f.meta && f.meta.starred).length}`],
      ['rejected', `废片 ${rejectedCount}`],
    ];
    // 标签筛选：汇总全部索引媒体的标签
    const tagSet = new Map();
    for (const f of allMedia) (f.meta && f.meta.tags || []).forEach(t => tagSet.set(t, (tagSet.get(t) || 0) + 1));
    S.toolbar.replaceChildren(
      h('input', { class: 'field', placeholder: '搜索文件名/备注/标签…', value: S.query,
        oninput: e => { S.query = e.target.value; this.render(root, win); } }),
      h('div', { class: 'chipbar' },
        chips.map(([id, label]) => h('button', {
          class: 'chip' + (S.filter === id ? ' on' : ''),
          onclick: () => { S.filter = id; this.buildToolbar(root, win); this.render(root, win); },
        }, label)),
      ),
      h('select', { class: 'field', title: '按标签筛选', onchange: e => { S.tag = e.target.value; this.render(root, win); } },
        h('option', { value: '' }, '全部标签'),
        Array.from(tagSet.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
          .map(([t, n]) => h('option', { value: t, selected: S.tag === t ? 'selected' : null }, `${t} (${n})`)),
      ),
      h('select', { class: 'field sort-field', title: '素材排序', onchange: e => { S.sort = e.target.value; this.render(root, win); } },
        h('option', { value: 'newest', selected: S.sort === 'newest' ? 'selected' : null }, '最新修改'),
        h('option', { value: 'oldest', selected: S.sort === 'oldest' ? 'selected' : null }, '最早修改'),
        h('option', { value: 'name', selected: S.sort === 'name' ? 'selected' : null }, '按名称'),
        h('option', { value: 'size', selected: S.sort === 'size' ? 'selected' : null }, '按大小'),
        h('option', { value: 'folder', selected: S.sort === 'folder' ? 'selected' : null }, '按文件夹'),
      ),
      h('button', { class: 'chip' + (S.showHidden ? ' on' : ''), title: '控制是否包含素材库内以 . 开头的隐藏子目录',
        onclick: () => { S.showHidden = !S.showHidden; this.buildToolbar(root, win); this.render(root, win); } },
        S.showHidden ? '隐藏目录：已包含' : '隐藏目录：已排除'),
      h('button', { class: 'btn small', onclick: () => this.importFiles(root, win) }, '＋ 导入视频'),
      h('button', { class: 'btn small', onclick: openAssetFolder }, '打开文件夹'),
      S.count = h('span', { class: 'assets-count' }),
    );
    const extra = h('div', { class: 'library-advanced-controls', id: 'mediaExtraFilters', hidden: S.advancedOpen ? null : '' });
    const advanced = h('button', {
      class: 'btn small library-advanced-toggle', type: 'button',
      'aria-expanded': String(!!S.advancedOpen), 'aria-controls': 'mediaExtraFilters',
      onclick: () => {
        S.advancedOpen = !S.advancedOpen;
        advanced.setAttribute('aria-expanded', String(S.advancedOpen));
        extra.hidden = !S.advancedOpen;
      },
    }, '更多筛选');
    const chipBar = S.toolbar.querySelector('.chipbar');
    [...chipBar.children].slice(3).forEach(button => extra.append(button));
    [...S.toolbar.children].filter(element => element.title === '按标签筛选'
      || element.title.includes('隐藏子目录') || element.textContent === '打开文件夹').forEach(element => extra.append(element));
    S.toolbar.insertBefore(h('button', {
      class: 'btn small', 'data-reflash': '1', title: '刷新素材索引',
      onclick: () => refreshMediaLibraries().then(() => toast('扫描完成')).catch(error => toast(error.message)),
    }, '刷新'), S.count);
    S.toolbar.insertBefore(advanced, S.count);
    S.toolbar.append(extra);
  },
  importFiles(root, win) {
    LibraryView.importFiles('video', win.state.project);
  },
  render(root, win) {
    const S = win.state;
    const scan = Store.scan;
    let files = scan.files.filter(f => ['video', 'image'].includes(f.type) && (S.showHidden || !f.hidden));
    if (S.source !== 'all') files = files.filter(f => f.sourceId === S.source || f.linkedSourceId === S.source || (S.source === 'project-assets' && !f.sourceId));
    if (S.project && S.project !== 'all') files = files.filter(file => LibraryView.projectKey(file) === S.project);
    // 废片默认不混入正常视图，只有「废片」筛选里能看到
    if (S.filter === 'rejected') files = files.filter(f => f.meta && f.meta.rejected);
    else files = files.filter(f => !(f.meta && f.meta.rejected));
    if (S.filter === 'starred') files = files.filter(f => f.meta && f.meta.starred);
    else if (S.filter === 'final') files = files.filter(f => f.meta && f.meta.isFinal === true);
    else if (S.filter === 'video' || S.filter === 'image') files = files.filter(f => f.type === S.filter);
    if (S.tag) files = files.filter(f => ((f.meta && f.meta.tags) || []).includes(S.tag));
    if (S.query) {
      const q = S.query.toLowerCase();
      files = files.filter(f => (`${f.displayPath || f.path} ` + ((f.meta && f.meta.note) || '') + ' ' + ((f.meta && f.meta.tags) || []).join(' ')).toLowerCase().includes(q));
    }
    files = sortAssets(files, S.sort);

    S.count.textContent = `${files.length} 项 · ${fmtBytes(files.reduce((sum, f) => sum + f.size, 0))}`;
    S.viewList = files;
    S.grid.replaceChildren();
    if (!files.length) {
      const totalMedia = scan.files.filter(f => ['video', 'image'].includes(f.type)).length;
      if (!totalMedia) {
        S.grid.appendChild(h('div', { class: 'empty-tip empty-guide', style: 'grid-column:1/-1' },
          h('div', { class: 'guide-title' }, '还没有可索引的图片或视频'),
          h('p', {}, '工作台导入的图片和视频会自动出现在这里，也可添加 Downloads 或其他媒体目录。'),
          h('div', { class: 'guide-actions' },
            h('button', { class: 'btn primary', onclick: () => this.importFiles(root, win) }, '选择视频导入'),
            h('button', { class: 'btn', onclick: openAssetFolder }, '打开素材库文件夹'),
          ),
        ));
      } else {
        S.grid.appendChild(h('div', { class: 'empty-tip', style: 'grid-column:1/-1' },
          S.filter === 'rejected' ? '还没有废片。' : '当前筛选条件下没有媒体。'));
      }
    }
    S.grid.classList.add('project-grouped-grid');
    S.grid.append(...LibraryView.groups(files, file => this.card(root, win, file, files.indexOf(file)), 'project-media-grid'));
    this.renderSelbar(root, win);


  },
  /* ---- 多选与批量操作 ---- */
  toggleSel(root, win, f, idx, shiftKey) {
    const S = win.state;
    if (shiftKey && S.lastSelIndex >= 0 && S.viewList) {
      const [a, b] = [Math.min(S.lastSelIndex, idx), Math.max(S.lastSelIndex, idx)];
      for (let i = a; i <= b; i++) if (S.viewList[i]) S.selected.add(S.viewList[i].path);
    } else if (S.selected.has(f.path)) {
      S.selected.delete(f.path);
    } else {
      S.selected.add(f.path);
    }
    S.lastSelIndex = idx;
    this.render(root, win);
  },
  renderSelbar(root, win) {
    const S = win.state;
    const scan = Store.scan;
    const sel = [...S.selected].map(p => scan.files.find(f => f.path === p)).filter(Boolean);
    if (!sel.length) { S.selbar.classList.add('hidden'); S.selbar.replaceChildren(); return; }
    S.selbar.classList.remove('hidden');
    const refresh = async () => {
      this.buildToolbar(root, win);
      this.render(root, win);
    };
    const apply = async (label, patch) => {
      try {
        for (const f of sel) await Store.setMeta(f.path, patch);
        toast(`已对 ${sel.length} 项${label}`);
        await refresh();
      } catch (err) { toast('批量操作失败：' + err.message); }
    };
    const tagInput = h('input', { class: 'field sel-tag-input', placeholder: '批量加标签，回车确认' });
    tagInput.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      const tag = tagInput.value.trim();
      if (!tag) return;
      try {
        for (const f of sel) {
          const tags = [...new Set([...((f.meta && f.meta.tags) || []), tag])];
          await Store.setMeta(f.path, { tags });
        }
        toast(`已给 ${sel.length} 项添加标签「${tag}」`);
        tagInput.value = '';
        await refresh();
      } catch (err) { toast('标签保存失败：' + err.message); }
    });
    S.selbar.replaceChildren(
      h('span', { class: 'sel-count' }, `已选 ${sel.length} 项`),
      h('button', { class: 'btn small', onclick: () => apply('收藏', { starred: true }) }, '★ 收藏'),
      h('button', { class: 'btn small', onclick: () => apply('标记为成品', { isFinal: true }) }, '成片'),
      h('select', { class: 'field sel-rating', title: '批量评星', onchange: async e => {
        const v = parseInt(e.target.value, 10);
        if (v >= 1 && v <= 5) await apply(`评 ${v} 星`, { rating: v });
        e.target.value = '';
      } },
        h('option', { value: '' }, '评星…'),
        [1, 2, 3, 4, 5].map(v => h('option', { value: String(v) }, '★'.repeat(v))),
      ),
      h('button', { class: 'btn small', onclick: () => apply('标为废片', { rejected: true }) }, '废片'),
      h('button', { class: 'btn small', onclick: () => apply('恢复', { rejected: false }) }, '恢复'),
      tagInput,
      h('button', { class: 'btn small primary', title: '并排对比所选素材（最多 9 项）',
        onclick: () => {
          if (sel.length < 2) { toast('对比至少需要选择 2 项'); return; }
          CompareBox.open(sel);
        } }, '对比'),
      h('button', { class: 'btn small', style: 'margin-left:auto', onclick: () => { S.selected.clear(); this.render(root, win); } }, '清除选择'),
    );
  },
  card(root, win, f, idx) {
    const S = win.state;
    const meta = f.meta || {};
    const star = !!meta.starred;
    const thumb = h('div', { class: 'asset-thumb' });
    let mediaEl = null;
    if (f.type === 'image') {
      thumb.appendChild(h('img', { src: fileUrl(f.path), loading: 'lazy', alt: f.name, draggable: 'false' }));
    } else if (f.type === 'video') {
      mediaEl = h('video', { src: fileUrl(f.path) + '#t=0.5', preload: 'metadata', muted: true, draggable: 'false' });
      thumb.appendChild(mediaEl);
    } else {
      thumb.appendChild(h('span', { html: ICONS[f.type] || ICONS.doc }));
    }
    // 时长角标（视频/音频元数据就绪后填充）
    const durBadge = h('span', { class: 'thumb-dur' });
    if (mediaEl) {
      mediaEl.addEventListener('loadedmetadata', () => { durBadge.textContent = fmtDur(mediaEl.duration); });
      // 悬停刷帧：鼠标横扫缩略图快速浏览画面
      let scrubAt = 0;
      thumb.addEventListener('pointermove', e => {
        const now = performance.now();
        if (now - scrubAt < 90) return;
        scrubAt = now;
        if (!mediaEl.duration) return;
        const r = thumb.getBoundingClientRect();
        mediaEl.currentTime = Math.max(0, Math.min(0.98, (e.clientX - r.left) / r.width)) * mediaEl.duration;
      });
    }
    thumb.appendChild(durBadge);
    const selected = S.selected.has(f.path);
    const cardEl = h('div', {
      class: 'asset-card' + (meta.rejected ? ' rejected' : '') + (selected ? ' selected' : ''),
      title: f.displayPath || f.path,
    },
      thumb,
      h('span', { class: 'type-badge ' + f.type }, TYPE_NAME[f.type]),
      h('button', {
        class: 'sel-dot' + (selected ? ' on' : ''),
        title: '选择（可按住 Shift 连选）',
        onclick: e => { e.stopPropagation(); this.toggleSel(root, win, f, idx, e.shiftKey); },
      }, selected ? '✓' : ''),
      h('button', {
        class: 'star-btn' + (star ? ' on' : ''), title: star ? '取消收藏' : '收藏',
        onclick: async e => {
          e.stopPropagation();
          try {
            await Store.setMeta(f.path, { starred: !star });
            this.buildToolbar(root, win); this.render(root, win);
          } catch (err) { toast('收藏保存失败：' + err.message); }
        },
      }, star ? '★' : '☆'),
      meta.isFinal ? h('span', { class: 'final-badge' }, '成片') : null,
      meta.rejected ? h('span', { class: 'rejected-badge' }, '废片') : null,
      h('div', { class: 'asset-info' },
        h('div', { class: 'asset-name' }, f.name),
        h('div', { class: 'asset-sub' },
          `${f.sizeText} · ${fmtDate(f.mtime)}`,
          meta.rating ? h('span', { class: 'rate-hint' }, ` · ${'★'.repeat(meta.rating)}`) : null,
        ),
        h('div', { class: 'asset-sub', title: f.displayPath || f.path }, f.displayPath || f.path),
      ),
    );
    cardEl.addEventListener('click', e => {
      if (e.ctrlKey || e.metaKey) { this.toggleSel(root, win, f, idx, e.shiftKey); return; }
      Lightbox.open(f, () => { this.buildToolbar(root, win); this.render(root, win); }, null, win.state.viewList);
    });
    return cardEl;
  },
};

/* ---------- 应用：音频库 ---------- */
const AudioApp = {
  id: 'audio', title: '音频素材', pageTitle: '音频素材', eyebrow: 'AUDIO LIBRARY', subtitle: '对白、音效与配乐素材', icon: ICONS.audio, width: 980, height: 630,
  async mount(root, win) {
    const S = win.state;
    S.query = ''; S.folder = 'all'; S.project = 'all'; S.sort = 'newest'; S.showHidden = false;
    S.durSpans = {};
    root.replaceChildren(h('div', { class: 'audio-app' },
      S.hero = h('div', { class: 'audio-hero' }),
      S.toolbar = h('div', { class: 'audio-toolbar' }),
      h('div', { class: 'audio-layout' },
        S.folders = h('aside', { class: 'audio-folders' }),
        S.list = h('div', { class: 'audio-list' }),
      ),
    ));
    try {
      await Store.loadScan();
    } catch (err) {
      root.replaceChildren(errorView('音频扫描失败：' + err.message, () => this.mount(root, win)));
      return;
    }
    this.render(root, win);
  },
  all() {
    return Store.scan.files.filter(f => f.type === 'audio');
  },
  render(root, win) {
    const S = win.state;
    S.hero.replaceChildren(h('div', { class: 'audio-hero-copy' }, h('h3', {}, '音频素材')),
      h('span', {}, `${this.all().length} 项 · 与工作台同步`));
    S.toolbar.replaceChildren(
      h('input', { class: 'field', placeholder: '搜索音频…', value: S.query, oninput: e => { S.query = e.target.value; this.renderList(root, win); } }),
      h('select', { class: 'field', 'aria-label': '音频排序', onchange: e => { S.sort = e.target.value; this.renderList(root, win); } },
        h('option', { value: 'newest', selected: S.sort === 'newest' ? '' : null }, '最新修改'),
        h('option', { value: 'name', selected: S.sort === 'name' ? '' : null }, '按名称')),
      h('button', { class: 'btn small', onclick: () => this.importFiles(root, win) }, '＋ 导入音频'),
      h('button', { class: 'btn small', onclick: () => window.EditorExports.open({ projectId: S.project }) }, '剪映导出'),
      h('button', { class: 'btn small', onclick: () => LibraryView.configure() }, '文件夹索引'),
      h('button', { class: 'btn small', onclick: () => refreshMediaLibraries().catch(error => toast(error.message)) }, '刷新'),
      S.count = h('span', { class: 'assets-count' }),
    );
    this.renderFolders(root, win);
    this.renderList(root, win);
  },
  available(win) {
    return this.all().filter(f => (win.state.showHidden || !f.hidden) && (!win.state.project || win.state.project === 'all' || LibraryView.projectKey(f) === win.state.project));
  },
  renderFolders(root, win) {
    const S = win.state;
    const all = this.all();
    const entries = [['all', '全部剧本'], ...(Store.scan.projects || []).map(project => [project.id, project.name]), ['unassigned', '未归属']];
    S.folders.replaceChildren(h('div', { class: 'audio-folders-title' }, '归属剧本'),
      ...entries.map(([id, name]) => h('button', {
        class: 'audio-folder' + (S.project === id ? ' on' : ''), onclick: () => {
          S.project = id; S.folder = 'all'; this.renderFolders(root, win); this.renderList(root, win);
        },
      }, h('span', { class: 'audio-folder-name' }, name), h('b', {}, String(all.filter(file => id === 'all' || LibraryView.projectKey(file) === id).length)))),
    );
  },
  importFiles(root, win) {
    LibraryView.importFiles('audio', win.state.project);
  },
  renderList(root, win) {
    const S = win.state;
    let files = this.available(win);
    if (S.folder !== 'all') files = files.filter(f => parentFolderOf(f.displayPath || f.path) === S.folder);
    if (S.query.trim()) {
      const q = S.query.trim().toLowerCase();
      files = files.filter(f =>
        ((f.displayPath || f.path) + ' ' + (f.projectName || '') + ' ' + ((f.meta && f.meta.note) || '') + ' ' + ((f.meta && f.meta.tags) || []).join(' ')).toLowerCase().includes(q));
    }
    files = sortAssets(files, S.sort);
    S.viewList = files;
    S.count.textContent = `${files.length} 条 · ${fmtBytes(files.reduce((sum, f) => sum + f.size, 0))}`;
    if (!files.length) {
      if (!this.all().length) {
        S.list.replaceChildren(h('div', { class: 'empty-tip audio-empty empty-guide' },
          h('div', { class: 'guide-title' }, '还没有音频素材'),
          h('p', {}, '在创作工作台或这里导入音频后，会自动收录并按原文件夹归组，不需要重复上传。'),
          h('div', { class: 'guide-actions' },
            h('button', { class: 'btn primary', onclick: () => this.importFiles(root, win) }, '选择音频导入'),
            h('button', { class: 'btn', onclick: openAssetFolder }, '打开素材库文件夹'),
          ),
        ));
      } else {
        S.list.replaceChildren(h('div', { class: 'empty-tip audio-empty' }, '当前筛选条件下没有音频。'));
      }
      return;
    }
    S.list.replaceChildren(...LibraryView.groups(files, file => this.row(root, win, file), 'project-audio-list'));
  },
  row(root, win, f) {
    const S = win.state;
    const meta = f.meta || {};
    const tags = Array.isArray(meta.tags) ? meta.tags : [];
    const openDetail = () => {
      $$('.audio-player').forEach(player => player.pause());
      Lightbox.open(f, () => this.render(root, win), null, win.state.viewList);
    };
    return h('article', { class: 'audio-row' + (f.hidden ? ' analysis-audio' : ''), title: f.path },
      h('div', { class: 'audio-row-icon', html: ICONS.audio }),
      h('div', { class: 'audio-row-main' },
        h('button', { class: 'audio-name', title: '打开音频详情', onclick: openDetail }, f.name),
        h('div', { class: 'audio-path', title: f.displayPath || f.path }, f.projectName || '未归属'),
        h('div', { class: 'audio-row-meta' },
          S.durSpans[f.path] = h('span', { class: 'audio-dur' }, ''),
          h('span', {}, f.sizeText),
          h('span', { class: 'tag green' }, f.audioRole === 'bgm' ? 'BGM' : f.audioRole === 'sfx' ? '音效' : f.exportKind === 'voice' ? '人物音频' : '对白 / 音频'),
          ...tags.map(tag => h('span', { class: 'tag blue' }, tag)),
        ),
      ),
      (() => {
        const player = h('audio', { class: 'audio-player', src: fileUrl(f.path), controls: true, preload: 'metadata',
          onplay: e => $$('.audio-player').forEach(p => { if (p !== e.currentTarget) p.pause(); }),
          onerror: () => toast(`无法在浏览器内播放 ${f.ext}，可打开详情后在文件管理器中定位`),
        });
        player.addEventListener('loadedmetadata', () => {
          const span = S.durSpans[f.path];
          if (span) span.textContent = fmtDur(player.duration);
        });
        return player;
      })(),
      h('div', { class: 'audio-row-actions' },
        h('button', { class: 'btn small' + (meta.starred ? ' audio-starred' : ''), onclick: async () => {
          try { await Store.setMeta(f.path, { starred: !meta.starred }); this.render(root, win); }
          catch (err) { toast('收藏保存失败：' + err.message); }
        }}, meta.starred ? '★ 已收藏' : '☆ 收藏'),
        h('button', { class: 'btn small', onclick: openDetail }, '详情'),
        h('button', { class: 'btn small', onclick: () => window.AssetSources.open({ file: f, projectId: f.projectId }) }, '用于本剧'),
      ),
    );
  },
};

/* ---------- 应用：Obsidian 层级索引 ---------- */
const ObsidianApp = {
  id: 'obsidian', title: 'Obsidian 资产', pageTitle: 'Obsidian 资产', eyebrow: 'VISUAL ASSETS', subtitle: '人物、服装、场景与色卡只读索引', icon: ICONS.obsidian, width: 1120, height: 680,
  _ctx: null, // {root, win}，供全局搜索跳转定位
  async mount(root, win) {
    this._ctx = { root, win };
    const S = win.state;
    S.currentPath = S.currentPath || '';
    S.query = '';
    root.replaceChildren(h('div', { class: 'obsidian-app' },
      h('div', { class: 'obsidian-loading' }, '正在连接 Obsidian…'),
    ));
    await this.reload(root, win, true);
  },
  /* 从全局搜索跳转：定位到笔记所在文件夹并打开笔记 */
  async openNoteByPath(path) {
    const ctx = this._ctx;
    if (!ctx) return;
    const S = ctx.win.state;
    for (let i = 0; i < 30 && !S.data; i++) await new Promise(r => setTimeout(r, 100)); // 等首次加载
    if (!S.data) return;
    S.currentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    this.build(ctx.root, ctx.win);
    await this.openNote(ctx.root, ctx.win, {
      path,
      name: path.split('/').pop().replace(/\.md$/i, ''),
    });
  },
  async reload(root, win, firstLoad) {
    const S = win.state;
    try {
      S.data = await requestJson('/api/obsidian/tree');
      if (!S.data.available || !S.data.tree) throw new Error('未找到本机 Obsidian Vault');
      if (!this.findFolder(S.data.tree, S.currentPath)) {
        S.currentPath = '';
      }
      this.build(root, win);
    } catch (err) {
      root.replaceChildren(h('div', { class: 'obsidian-app' },
        errorView('Obsidian 连接失败：' + err.message, () => this.reload(root, win, false)),
      ));
    }
  },
  build(root, win) {
    const S = win.state;
    const stats = S.data.stats || { folders: 0, files: 0, notes: 0 };
    const navCount = document.querySelector('[data-app-count="obsidian"]');
    if (navCount) navCount.textContent = String(stats.notes);
    S.search = h('input', {
      class: 'field obsidian-search', type: 'search', placeholder: '只搜索文件夹和文件名…', autocomplete: 'off',
      oninput: e => { S.query = e.target.value; this.renderEntries(root, win); },
    });
    S.folderTree = h('div', { class: 'obsidian-folder-tree' });
    S.breadcrumb = h('div', { class: 'obsidian-breadcrumb' });
    S.entries = h('div', { class: 'obsidian-entries' });
    S.viewer = h('article', { class: 'obsidian-viewer' },
      h('div', { class: 'obsidian-empty' }, '选择一个笔记或媒体文件进行预览'),
    );
    root.replaceChildren(h('div', { class: 'obsidian-app' },
      h('header', { class: 'obsidian-head' },
        h('div', { class: 'obsidian-brand' },
          h('span', { class: 'obsidian-logo', html: ICONS.obsidian }),
          h('div', {},
            h('h2', {}, S.data.rootName),
            h('p', {}, '严格沿用 Vault 的文件夹、文件名和上下级关系'),
          ),
        ),
        h('div', { class: 'obsidian-stats' },
          h('span', {}, h('b', {}, String(stats.folders)), ' 文件夹'),
          h('span', {}, h('b', {}, String(stats.notes)), ' 笔记'),
          h('span', {}, h('b', {}, String(stats.files)), ' 文件'),
          h('button', { class: 'btn small', onclick: async e => {
            const btn = e.currentTarget; btn.disabled = true; btn.textContent = '刷新中…';
            await this.reload(root, win, false); toast('Obsidian 索引已刷新');
          } }, '刷新索引'),
        ),
      ),
      h('div', { class: 'obsidian-workspace' },
        h('aside', { class: 'obsidian-sidebar' },
          S.search,
          h('div', { class: 'obsidian-side-label' }, '文件夹'),
          S.folderTree,
        ),
        h('main', { class: 'obsidian-content' },
          S.breadcrumb,
          h('div', { class: 'obsidian-columns' }, S.entries, S.viewer),
        ),
      ),
    ));
    this.renderFolderTree(root, win);
    this.renderEntries(root, win);
  },
  findFolder(node, targetPath) {
    if (!node || node.kind !== 'folder') return null;
    if (node.path === targetPath) return node;
    for (const child of node.children || []) {
      if (child.kind !== 'folder') continue;
      const found = this.findFolder(child, targetPath);
      if (found) return found;
    }
    return null;
  },
  flatten(node, out = []) {
    for (const child of node.children || []) {
      out.push(child);
      if (child.kind === 'folder') this.flatten(child, out);
    }
    return out;
  },
  renderFolderTree(root, win) {
    const S = win.state;
    S.folderTree.replaceChildren();
    const addFolder = (folder, depth) => {
      const label = folder.path ? folder.name : S.data.rootName;
      S.folderTree.appendChild(h('button', {
        class: 'obsidian-folder-button' + (folder.path === S.currentPath ? ' on' : ''),
        style: `padding-left:${10 + depth * 15}px`, title: folder.path || S.data.rootName,
        onclick: () => this.selectFolder(root, win, folder.path),
      },
        h('span', { class: 'obsidian-folder-caret' }, '›'),
        h('span', { class: 'obsidian-folder-name' }, label),
      ));
      (folder.children || []).filter(item => item.kind === 'folder').forEach(child => addFolder(child, depth + 1));
    };
    addFolder(S.data.tree, 0);
  },
  selectFolder(root, win, path) {
    const S = win.state;
    S.currentPath = path;
    S.query = '';
    if (S.search) S.search.value = '';
    this.renderFolderTree(root, win);
    this.renderEntries(root, win);
  },
  renderBreadcrumb(root, win) {
    const S = win.state;
    S.breadcrumb.replaceChildren();
    const add = (label, path) => S.breadcrumb.appendChild(h('button', {
      class: 'obsidian-crumb', onclick: () => this.selectFolder(root, win, path),
    }, label));
    add(S.data.rootName, '');
    let current = '';
    for (const part of S.currentPath.split('/').filter(Boolean)) {
      S.breadcrumb.appendChild(h('span', { class: 'obsidian-crumb-sep' }, '/'));
      current = current ? `${current}/${part}` : part;
      add(part, current);
    }
  },
  renderEntries(root, win) {
    const S = win.state;
    this.renderBreadcrumb(root, win);
    const query = S.query.trim().toLocaleLowerCase('zh-CN');
    const folder = this.findFolder(S.data.tree, S.currentPath) || S.data.tree;
    let items = query
      ? this.flatten(S.data.tree).filter(item => item.name.toLocaleLowerCase('zh-CN').includes(query))
      : [...(folder.children || [])];
    S.entries.replaceChildren(h('div', { class: 'obsidian-list-head' },
      h('strong', {}, query ? `名称搜索：${S.query.trim()}` : (folder.name || S.data.rootName)),
      h('span', {}, `${items.length} 项`),
    ));
    const shown = items.slice(0, 600);
    for (const item of shown) {
      const icon = item.kind === 'folder' ? ICONS.creativeAssets : item.kind === 'note' ? ICONS.doc : item.previewable ? ICONS.image : ICONS.doc;
      const label = item.kind === 'note' ? item.name.replace(/\.md$/i, '') : item.name;
      S.entries.appendChild(h('button', {
        class: `obsidian-entry ${item.kind}`,
        title: item.path,
        onclick: () => {
          if (item.kind === 'folder') this.selectFolder(root, win, item.path);
          else if (item.kind === 'note') this.openNote(root, win, item);
          else this.openFile(win, item);
        },
      },
        h('span', { class: 'obsidian-entry-icon', html: icon, 'aria-hidden': 'true' }),
        h('span', { class: 'obsidian-entry-main' },
          h('span', { class: 'obsidian-entry-name' }, label),
          h('span', { class: 'obsidian-entry-path' }, item.path),
        ),
        item.sizeText ? h('span', { class: 'obsidian-entry-size' }, item.sizeText) : null,
      ));
    }
    if (!items.length) S.entries.appendChild(h('div', { class: 'empty-tip' }, '没有匹配的文件夹或文件名'));
    if (items.length > shown.length) {
      S.entries.appendChild(h('div', { class: 'empty-tip' }, `当前仅显示前 ${shown.length} 项，请用名称搜索快速定位`));
    }
  },
  async openNote(root, win, item) {
    const S = win.state;
    S.viewer.replaceChildren(h('div', { class: 'obsidian-empty' }, '正在读取笔记…'));
    try {
      const data = await requestJson(`/api/obsidian/note?p=${encodeURIComponent(item.path)}`);
      const body = h('div', { class: 'obsidian-note-body' });
      renderMD(data.content, body);
      S.viewer.replaceChildren(
        h('header', { class: 'obsidian-viewer-head' },
          h('div', {}, h('h2', {}, data.name), h('p', {}, data.path)),
          h('div', { class: 'obsidian-viewer-meta' },
            h('span', {}, `更新 ${fmtDate(data.mtime)}`),
            h('span', {}, `${data.resolvedEmbeds} 个嵌入附件`),
            data.unresolvedEmbeds ? h('span', { class: 'warn' }, `${data.unresolvedEmbeds} 个附件未解析`) : null,
          ),
        ),
        body,
      );
      S.viewer.scrollTop = 0;
    } catch (err) {
      S.viewer.replaceChildren(errorView('笔记读取失败：' + err.message, () => this.openNote(root, win, item)));
    }
  },
  openFile(win, item) {
    const S = win.state;
    if (!item.previewable) {
      S.viewer.replaceChildren(h('div', { class: 'obsidian-empty' },
        h('strong', {}, item.name), h('span', {}, '该文件保留在原层级中，但当前不支持浏览器预览'),
      ));
      return;
    }
    const url = obsidianFileUrl(item.path);
    const ext = String(item.ext || '').toLowerCase();
    let media;
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'].includes(ext)) {
      media = h('img', { class: 'obsidian-media-image', src: url, alt: item.name });
    } else if (['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'].includes(ext)) {
      media = h('audio', { class: 'obsidian-media-audio', src: url, controls: true, preload: 'metadata' });
    } else if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) {
      media = h('video', { class: 'obsidian-media-video', src: url, controls: true, preload: 'metadata' });
    } else {
      media = h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, '打开文件');
    }
    S.viewer.replaceChildren(
      h('header', { class: 'obsidian-viewer-head' },
        h('div', {}, h('h2', {}, item.name), h('p', {}, item.path)),
        h('div', { class: 'obsidian-viewer-meta' }, h('span', {}, item.sizeText || ''),
          h('button', { class: 'btn', onclick: () => window.AssetSources.open({ file: { ...item, origin: 'obsidian' } }) }, '用于本剧')),
      ),
      h('div', { class: 'obsidian-media-stage' }, media),
    );
  },
};

/* ---------- 应用：蒸馏文库 ---------- */
const DistillApp = {
  id: 'distill', title: '项目知识', pageTitle: '项目知识', eyebrow: 'PROJECT KNOWLEDGE', subtitle: '蒸馏文档、工具规则与制作方法', icon: ICONS.distill, width: 1020, height: 640,
  GROUPS: [
    ['distill', '蒸馏文档（VIDEO）'],
    ['tool', '工具知识库（TOOL）'],
    ['manual', '手册与 SOP'],
    ['system', '系统文件'],
  ],
  async mount(root, win) {
    const S = win.state;
    S.selected = null; S.query = '';
    root.replaceChildren(
      h('div', { class: 'distill-app' },
        h('div', { class: 'doc-list' },
          h('div', { class: 'doc-list-head' },
            S.search = h('input', { class: 'field', placeholder: '筛选文档…',
              oninput: e => { S.query = e.target.value; this.renderList(root, win); } }),
          ),
          S.list = h('div', { class: 'doc-groups' }),
        ),
        S.viewer = h('div', { class: 'doc-viewer' },
          h('div', { class: 'empty-tip' }, '← 选择左侧文档开始阅读')),
      ),
    );
    try {
      await Store.loadScan();
    } catch (err) {
      root.replaceChildren(errorView('文库扫描失败：' + err.message, () => this.mount(root, win)));
      return;
    }
    // 加载文档批注
    try {
      S.annotations = await requestJson('/api/annotations');
    } catch (err) {
      S.annotations = { version: 1, items: {} };
      toast('文档批注暂不可用：' + err.message);
    }
    this.renderList(root, win);
    if (win.openTarget) { this.openDoc(root, win, win.openTarget); win.openTarget = null; }
  },
  getAnnotation(path) {
    const S = this._winState;
    return (S && S.annotations && S.annotations.items && S.annotations.items[path])
      || { bookmarked: false, note: '' };
  },
  async saveAnnotation(path, patch) {
    const S = this._winState;
    const data = await requestJson('/api/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...patch }),
    });
    if (!data || !data.item) throw new Error('文档批注保存失败');
    S.annotations = S.annotations || { version: 1, items: {} };
    S.annotations.items = S.annotations.items || {};
    S.annotations.items[path] = data.item;
    return data.item;
  },
  renderList(root, win) {
    this._winState = win.state;
    const S = win.state;
    const docs = Store.scan.docs.filter(d =>
      !S.query || (d.title + d.id + (d.manifest ? d.manifest.purpose : '')).toLowerCase().includes(S.query.toLowerCase()));
    S.list.replaceChildren();
    for (const [gid, gname] of this.GROUPS) {
      const items = docs.filter(d => d.group === gid);
      if (!items.length) continue;
      S.list.appendChild(h('div', { class: 'doc-group-title' }, gname));
      for (const d of items) {
        const ann = this.getAnnotation(d.path);
        const flags = [];
        if (d.group === 'distill' && !d.registered) flags.push('未登记');
        if (d.hidden) flags.push('隐藏目录');
        S.list.appendChild(h('div', {
          class: 'doc-item' + (S.selected === d.path ? ' on' : ''),
          onclick: () => this.openDoc(root, win, d.path),
        },
          h('div', { class: 'di-row' },
            h('span', { class: 'doc-id ' + d.group }, d.id),
            h('span', { class: 'di-name', title: d.title }, d.title),
            flags.length ? h('span', { class: 'di-flag' }, flags.join('·')) : null,
            ann.bookmarked ? h('span', { class: 'di-bm', title: '已收藏' }, '★') : null,
          ),
          d.summary ? h('div', { class: 'di-sum' }, d.summary) : null,
        ));
      }
    }
    if (!docs.length) S.list.appendChild(h('div', { class: 'empty-tip' }, '没有匹配的文档'));
  },
  async openDoc(root, win, path) {
    this._winState = win.state;
    const S = win.state;
    S.selected = path;
    this.renderList(root, win);
    const d = Store.scan.docs.find(x => x.path === path);
    const ann = this.getAnnotation(path);
    S.viewer.replaceChildren(h('div', { class: 'empty-tip' }, '加载中…'));
    try {
      const data = await requestJson(`/api/doc?p=${encodeURIComponent(path)}`);
      if (!data || typeof data.content !== 'string') throw new Error('文档数据格式无效');
      const head = h('div', { class: 'doc-viewer-head' },
        h('div', {},
          h('h2', {}, d.title),
          h('div', { class: 'dv-meta' },
            h('span', {}, `${(data.content.length / 1000).toFixed(1)}k 字`),
            h('span', {}, `更新 ${fmtDate(d.mtime)}`),
            d.manifest && d.manifest.priority ? h('span', {}, `优先章节：${d.manifest.priority}`) : null,
          ),
        ),
        h('div', { class: 'dv-actions' },
          h('button', { class: 'btn small', onclick: () => copyText(data.content) }, '复制全文'),
          h('button', { class: 'btn small', onclick: () => Lightbox.open(d, null, true) }, '全屏阅读'),
          h('button', {
            class: 'btn small' + (ann.bookmarked ? ' on' : ''),
            id: '_dvBm',
            onclick: async () => {
              const cur = this.getAnnotation(path);
              try {
                await this.saveAnnotation(path, { bookmarked: !cur.bookmarked });
                this.renderList(root, win);
                this.openDoc(root, win, path);
                toast(cur.bookmarked ? '已取消收藏' : '已收藏');
              } catch (err) { toast('书签保存失败：' + err.message); }
            },
          }, ann.bookmarked ? '★ 已收藏' : '☆ 收藏'),
        ),
      );
      // 个人笔记区
      const noteArea = h('div', { class: 'dv-note' },
        h('div', { class: 'dv-note-head' },
          h('span', {}, '个人笔记'),
          h('span', { class: 'dv-note-hint' }, '自动保存'),
        ),
        h('textarea', {
          class: 'field', id: '_dvNote', placeholder: '在此记录阅读笔记、使用心得…',
          value: ann.note || '',
        }),
      );
      const noteTa = noteArea.querySelector('textarea');
      let saveTimer;
      noteTa.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          try { await this.saveAnnotation(path, { note: noteTa.value }); }
          catch (err) { toast('笔记保存失败：' + err.message); }
        }, 600);
      });
      const body = h('div', {});
      renderMD(data.content, body);
      S.viewer.replaceChildren(head, noteArea, body);
      S.viewer.scrollTop = 0;
    } catch (e) {
      S.viewer.replaceChildren(h('div', { class: 'empty-tip' }, '读取失败：' + e.message));
    }
  },
};

/* ---------- 应用：Agent 经验 ---------- */
const AgentApp = {
  id: 'agent', title: 'Agent 与规则', pageTitle: 'Agent 与规则', eyebrow: 'AGENT OPERATIONS', subtitle: '触发协议、生产规则与可复制模板', icon: ICONS.agent, width: 980, height: 620,
  async mount(root, win) {
    const S = win.state;
    S.section = null;
    S.query = '';
    // 展开状态只属于当前窗口会话，不写入经验库数据。
    S.expandedCards = new Set();
    root.replaceChildren(h('div', { class: 'agent-app' },
      S.nav = h('div', { class: 'agent-nav' }),
      S.main = h('div', { class: 'agent-main' }),
    ));
    try {
      await Store.loadKnowledge();
    } catch (err) {
      root.replaceChildren(errorView('经验库加载失败：' + err.message, () => this.mount(root, win)));
      return;
    }
    const sections = Store.knowledge.sections;
    if (!S.section) S.section = win.openSection || (sections[0] && sections[0].id);
    const openCard = win.openCard;
    if (openCard) S.expandedCards.add(openCard);
    win.openSection = null;
    win.openCard = null;
    this.renderNav(root, win);
    this.renderMain(root, win);
    if (openCard) this.highlightCard(openCard);
  },
  async persistKnowledge(root, win) {
    try {
      await Store.saveKnowledge();
      return true;
    } catch (err) {
      toast('经验库保存失败：' + err.message);
      try { await Store.loadKnowledge(true); } catch {}
      this.renderNav(root, win);
      this.renderMain(root, win);
      return false;
    }
  },
  renderNav(root, win) {
    const S = win.state;
    S.nav.replaceChildren();
    for (const sec of Store.knowledge.sections) {
      S.nav.appendChild(h('div', { class: 'agent-nav-group' },
        h('button', {
          class: 'agent-nav-item' + (S.section === sec.id ? ' on' : ''),
          onclick: () => {
            S.section = sec.id;
            S.expandedCards.clear();
            this.renderNav(root, win);
            this.renderMain(root, win);
          },
        },
          h('span', {}, sec.name),
          h('span', { class: 'an-count' }, `${sec.items.length}`),
        ),
        h('button', {
          class: 'an-del-sec', title: '删除此分类',
          onclick: async (e) => {
            e.stopPropagation();
            if (sec.items.length && !confirm(`分类「${sec.name}」下有 ${sec.items.length} 张卡片，确定全部删除？`)) return;
            Store.knowledge.sections = Store.knowledge.sections.filter(s => s.id !== sec.id);
            if (!await this.persistKnowledge(root, win)) return;
            if (S.section === sec.id) S.section = (Store.knowledge.sections[0] && Store.knowledge.sections[0].id) || null;
            this.renderNav(root, win);
            this.renderMain(root, win);
            toast('分类已删除');
          },
        }, '✕'),
      ));
    }
    S.nav.appendChild(h('button', {
      class: 'agent-nav-item an-add-sec',
      onclick: () => this.showAddSection(root, win),
    }, h('span', {}, '+ 添加分类')));
  },
  renderMain(root, win) {
    const S = win.state;
    const sec = Store.knowledge.sections.find(x => x.id === S.section);
    if (!sec) { S.main.replaceChildren(h('div', { class: 'empty-tip' }, '选择左侧分类，或点击「添加分类」创建新分类')); return; }
    S.main.replaceChildren(
      h('div', { class: 'agent-main-head' },
        h('div', {},
          h('h3', {}, sec.name),
          h('p', {}, sec.desc || ''),
        ),
        h('input', {
          class: 'field agent-search', placeholder: '搜索卡片标题/标签/内容…', value: S.query,
          oninput: e => { S.query = e.target.value; this.renderCards(root, win); },
        }),
        S.cardCount = h('span', { class: 'agent-card-count' }),
        h('button', {
          class: 'btn primary small', style: 'flex-shrink:0',
          onclick: () => this.showAddCard(root, win, sec),
        }, '+ 添加卡片'),
      ),
      S.cards = h('div', { class: 'agent-cards' }),
    );
    this.renderCards(root, win);
  },
  renderCards(root, win) {
    const S = win.state;
    const sec = Store.knowledge.sections.find(x => x.id === S.section);
    if (!sec || !S.cards) return;
    const q = (S.query || '').trim().toLowerCase();
    const items = !q ? sec.items : sec.items.filter(item =>
      (item.title + ' ' + (item.tags || []).join(' ') + ' ' + item.body).toLowerCase().includes(q));
    if (S.cardCount) S.cardCount.textContent = q ? `${items.length} / ${sec.items.length} 张` : `${sec.items.length} 张`;
    S.cards.replaceChildren();
    if (!items.length) {
      S.cards.appendChild(h('div', { class: 'empty-tip' },
        q ? `没有匹配「${q}」的卡片` : '此分类还没有卡片，点击右上角「添加卡片」创建'));
      return;
    }
    for (const item of items) S.cards.appendChild(this.card(root, win, sec, item));
  },
  /* ---- 新建分类 ---- */
  showAddSection(root, win) {
    const S = win.state;
    const uid = '_ns' + Date.now();
    const wrap = h('div', { class: 'k-form-card k-card' },
      h('div', { class: 'k-form-title' }, '新建分类'),
      h('label', { class: 'k-form-label' }, '分类名称'),
      h('input', { class: 'field', id: uid + '_n', placeholder: '例如：提示词技巧' }),
      h('label', { class: 'k-form-label' }, '描述（可选）'),
      h('input', { class: 'field', id: uid + '_d', placeholder: '简短说明' }),
      h('div', { class: 'k-form-actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          const name = $('#' + uid + '_n').value.trim();
          if (!name) { toast('请输入分类名称'); return; }
          const id = 'sec_' + Date.now();
          Store.knowledge.sections.push({ id, name, desc: $('#' + uid + '_d').value.trim(), items: [] });
          if (!await this.persistKnowledge(root, win)) return;
          S.section = id;
          this.renderNav(root, win);
          this.renderMain(root, win);
          toast('分类已创建');
        }}, '创建'),
        h('button', { class: 'btn', onclick: () => this.renderNav(root, win) }, '取消'),
      ),
    );
    S.nav.appendChild(wrap);
    $('#' + uid + '_n').focus();
  },
  /* ---- 新建卡片 ---- */
  showAddCard(root, win, sec) {
    const S = win.state;
    const uid = '_nc' + Date.now();
    const form = h('div', { class: 'k-card k-form-card' },
      h('div', { class: 'k-card-head' }, h('h4', {}, '新建卡片')),
      h('div', { class: 'k-form-wrap' },
        h('label', { class: 'k-form-label' }, '标题'),
        h('input', { class: 'field', id: uid + '_t', placeholder: '卡片标题' }),
        h('label', { class: 'k-form-label' }, '标签（逗号分隔）'),
        h('input', { class: 'field', id: uid + '_g', placeholder: 'Seedance, 提示词' }),
        h('label', { class: 'k-form-label' }, '来源'),
        h('input', { class: 'field', id: uid + '_s', placeholder: 'TOOL-001 第9节' }),
        h('label', { class: 'k-form-label' }, '内容（支持 Markdown）'),
        h('textarea', { class: 'field k-edit-area', id: uid + '_b', placeholder: '输入卡片内容…' }),
        h('div', { class: 'k-form-actions' },
          h('button', { class: 'btn primary', onclick: async () => {
            const title = $('#' + uid + '_t').value.trim();
            const body = $('#' + uid + '_b').value.trim();
            if (!title) { toast('请输入标题'); return; }
            if (!body) { toast('请输入内容'); return; }
            sec.items.push({
              id: 'card_' + Date.now(),
              title,
              tags: $('#' + uid + '_g').value.split(/[,，]/).map(t => t.trim()).filter(Boolean),
              source: $('#' + uid + '_s').value.trim(),
              body,
            });
            if (!await this.persistKnowledge(root, win)) return;
            this.renderNav(root, win);
            this.renderMain(root, win);
            toast('卡片已创建');
          }}, '创建'),
          h('button', { class: 'btn', onclick: () => this.renderMain(root, win) }, '取消'),
        ),
      ),
    );
    S.main.appendChild(form);
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#' + uid + '_t').focus();
  },
  /* ---- 卡片渲染 ---- */
  card(root, win, sec, item) {
    const S = win.state;
    const panelId = `knowledge-card-${sec.id}-${item.id}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const panel = h('div', { class: 'k-card-panel', id: panelId });
    let rendered = false;
    let cardEl;

    const renderPanel = () => {
      if (rendered) return;
      const body = h('div', {});
      renderMD(item.body, body);
      panel.replaceChildren(
        h('div', { class: 'k-card-panel-head' },
          h('div', { class: 'k-card-tags' },
            (item.tags || []).map(t => h('span', { class: 'tag pink' }, t)),
          ),
          h('div', { class: 'k-card-actions' },
            h('button', { class: 'btn small', onclick: () => this.editCard(root, win, sec, item) }, '编辑'),
            h('button', { class: 'btn small', style: 'color:var(--accent)', onclick: () => this.deleteCard(root, win, sec, item) }, '删除'),
          ),
        ),
        body,
        h('div', { class: 'k-card-foot' },
          h('span', { class: 'k-src' }, item.source ? `来源：${item.source}` : ''),
          h('button', {
            class: 'btn small', title: '把这张卡片发送到创作浏览器的提示词编辑区',
            onclick: () => {
              try {
                localStorage.setItem('vos.pendingPrompt', JSON.stringify({ title: item.title, body: item.body, at: Date.now() }));
                toast('已发送：打开创作浏览器即可一键插入');
              } catch { toast('发送失败'); }
            },
          }, '→ 提示词区'),
          sec.id === 'openers'
            ? h('button', { class: 'btn primary', onclick: () => copyText(item.body) }, '复制开场包')
            : h('button', { class: 'btn', onclick: () => copyText(item.body) }, '复制'),
        ),
      );
      rendered = true;
    };

    const title = h('span', { class: 'k-card-title' }, item.title);
    const chevron = h('span', { class: 'k-card-chevron', 'aria-hidden': 'true' }, '›');
    const toggle = h('button', {
      class: 'k-card-toggle',
      type: 'button',
      'aria-controls': panelId,
    }, title, chevron);

    const setExpanded = (expanded) => {
      if (expanded) {
        S.expandedCards.add(item.id);
        renderPanel();
      } else {
        S.expandedCards.delete(item.id);
      }
      cardEl.classList.toggle('open', expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('title', `${expanded ? '收起' : '展开'}：${item.title}`);
      panel.hidden = !expanded;
    };

    cardEl = h('div', {
      class: 'k-card k-card-collapsible',
      'data-kid': item.id,
    }, toggle, panel);
    toggle.addEventListener('click', () => setExpanded(!S.expandedCards.has(item.id)));
    setExpanded(S.expandedCards.has(item.id));
    return cardEl;
  },
  /* ---- 编辑卡片（全字段） ---- */
  editCard(root, win, sec, item) {
    const cardEl = win.el.querySelector(`.k-card[data-kid="${item.id}"]`);
    if (!cardEl) return;
    win.state.expandedCards.add(item.id);
    cardEl.className = 'k-card k-form-card';
    const uid = '_ec' + Date.now();
    cardEl.replaceChildren(
      h('div', { class: 'k-card-head' }, h('h4', {}, '编辑：' + item.title)),
      h('div', { class: 'k-form-wrap' },
        h('label', { class: 'k-form-label' }, '标题'),
        h('input', { class: 'field', id: uid + '_t', value: item.title }),
        h('label', { class: 'k-form-label' }, '标签（逗号分隔）'),
        h('input', { class: 'field', id: uid + '_g', value: (item.tags || []).join(', ') }),
        h('label', { class: 'k-form-label' }, '来源'),
        h('input', { class: 'field', id: uid + '_s', value: item.source || '' }),
        h('label', { class: 'k-form-label' }, '内容（支持 Markdown）'),
        h('textarea', { class: 'field k-edit-area', id: uid + '_b' }),
        h('div', { class: 'k-form-actions' },
          h('button', { class: 'btn primary', onclick: async () => {
            const t = $('#' + uid + '_t').value.trim();
            const b = $('#' + uid + '_b').value;
            if (!t) { toast('标题不能为空'); return; }
            item.title = t;
            item.tags = $('#' + uid + '_g').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
            item.source = $('#' + uid + '_s').value.trim();
            item.body = b;
            if (!await this.persistKnowledge(root, win)) return;
            toast('已保存');
            this.renderMain(root, win);
          }}, '保存'),
          h('button', { class: 'btn', onclick: () => this.renderMain(root, win) }, '取消'),
        ),
      ),
    );
    const ta = $('#' + uid + '_b');
    ta.value = item.body;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
    ta.focus();
  },
  /* ---- 删除卡片 ---- */
  deleteCard(root, win, sec, item) {
    const cardEl = win.el.querySelector(`.k-card[data-kid="${item.id}"]`);
    if (!cardEl) return;
    win.state.expandedCards.add(item.id);
    cardEl.className = 'k-card k-form-card';
    cardEl.replaceChildren(h('div', { class: 'k-delete-confirm' },
      h('span', {}, `确定删除「${esc(item.title)}」？`),
      h('div', { class: 'k-form-actions' },
        h('button', { class: 'btn small primary', onclick: async () => {
          sec.items = sec.items.filter(i => i.id !== item.id);
          win.state.expandedCards.delete(item.id);
          if (!await this.persistKnowledge(root, win)) return;
          this.renderNav(root, win);
          this.renderMain(root, win);
          toast('卡片已删除');
        }}, '确认删除'),
        h('button', { class: 'btn small', onclick: () => this.renderMain(root, win) }, '取消'),
      ),
    ));
  },
  highlightCard(kid) {
    const el = $(`.k-card[data-kid="${kid}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  },
};

/* ---------- 应用：创作浏览器 ---------- */
const HEHUI_PROJECT_URL = 'https://hehui.dawncoreai.com/';
const INSPIRATION_PROJECT_ID = 'inspiration';

const CreatorEntry = {
  initialized: false,
  preferredMode: 'image',
  trigger: null,
  projects: [],
  activeProjectId: '',
  categories: [],
  busy: false,
  requestVersion: 0,
  actionVersion: 0,
  closeTimer: null,
  el: {},

  init() {
    if (this.initialized) return;
    this.el = Object.fromEntries([
      'scriptChooser', 'scriptChooserClose', 'scriptChooserCancel', 'inspirationProject',
      'scriptProjectList', 'scriptProjectCount', 'showNewProject', 'newProjectForm',
      'newProjectName', 'createProjectSubmit', 'cancelNewProject', 'scriptChooserStatus',
    ].map(id => [id, document.getElementById(id)]));
    const { scriptChooser: dialog } = this.el;
    if (!dialog) return;

    this.el.scriptChooserClose.addEventListener('click', () => this.close());
    this.el.scriptChooserCancel.addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      this.close();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) this.close();
    });
    dialog.addEventListener('close', () => {
      this.requestVersion += 1;
      this.actionVersion += 1;
      dialog.classList.remove('is-closing');
      this.setBusy(false);
      this.setCreateOpen(false, { clear: true });
      this.setStatus('');
      const target = this.trigger;
      this.trigger = null;
      if (target && target.isConnected) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    });

    this.el.inspirationProject.addEventListener('click', () => {
      this.activateProject(INSPIRATION_PROJECT_ID, '灵感生成');
    });
    this.el.showNewProject.addEventListener('click', () => {
      const opening = this.el.newProjectForm.hidden;
      this.setCreateOpen(opening);
      if (opening) requestAnimationFrame(() => this.el.newProjectName.focus());
    });
    this.el.cancelNewProject.addEventListener('click', () => {
      this.setCreateOpen(false, { clear: true });
      this.el.showNewProject.focus();
    });
    this.el.newProjectForm.addEventListener('submit', event => {
      event.preventDefault();
      this.createProject();
    });
    this.initialized = true;
  },

  normalizeMode(mode) {
    return mode === 'video' ? 'video' : 'image';
  },

  open({ preferredMode = 'image' } = {}) {
    this.init();
    const dialog = this.el.scriptChooser;
    if (!dialog) return;
    this.preferredMode = this.normalizeMode(preferredMode);
    if (!dialog.open) {
      this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : $('#createBtn');
      WM.open('creator');
      clearTimeout(this.closeTimer);
      dialog.classList.remove('is-closing');
      dialog.showModal();
      this.setCreateOpen(false);
      this.setStatus('');
      requestAnimationFrame(() => this.el.inspirationProject.focus({ preventScroll: true }));
    }
    this.loadProjects();
  },

  close({ immediate = false, restoreFocus = true } = {}) {
    const dialog = this.el.scriptChooser;
    if (!dialog?.open) return;
    // 关闭意图立即作废在途读取/激活，避免淡出期间的响应重新打开创作浏览器。
    this.requestVersion += 1;
    this.actionVersion += 1;
    clearTimeout(this.closeTimer);
    if (!restoreFocus) this.trigger = null;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (immediate || reduceMotion) {
      dialog.close();
      return;
    }
    dialog.classList.add('is-closing');
    this.closeTimer = setTimeout(() => {
      if (dialog.open) dialog.close();
    }, 170);
  },

  setCreateOpen(open, { clear = false } = {}) {
    const form = this.el.newProjectForm;
    if (!form) return;
    form.hidden = !open;
    this.el.showNewProject.setAttribute('aria-expanded', String(open));
    this.el.showNewProject.classList.toggle('expanded', open);
    if (clear) this.el.newProjectName.value = '';
  },

  setStatus(message, { error = false } = {}) {
    const status = this.el.scriptChooserStatus;
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', !!message && error);
    status.setAttribute('role', error ? 'alert' : 'status');
  },

  setBusy(busy, message = '') {
    this.busy = busy;
    const dialog = this.el.scriptChooser;
    if (!dialog) return;
    $$('button, input', dialog).forEach(control => {
      control.disabled = busy && control !== this.el.scriptChooserClose && control !== this.el.scriptChooserCancel;
    });
    dialog.setAttribute('aria-busy', String(busy));
    if (message) this.setStatus(message);
  },

  async loadProjects() {
    const version = ++this.requestVersion;
    const list = this.el.scriptProjectList;
    if (!list) return;
    list.setAttribute('aria-busy', 'true');
    list.replaceChildren(h('div', { class: 'script-project-state', role: 'status' }, '正在读取剧本…'));
    this.el.scriptProjectCount.textContent = '正在读取…';
    try {
      const data = await requestJson('/api/creative-projects', { cache: 'no-store' });
      if (version !== this.requestVersion) return;
      if (!data || !Array.isArray(data.projects)) throw new Error('剧本列表格式无效');
      this.projects = data.projects.filter(project => project && typeof project.id === 'string');
      this.activeProjectId = typeof data.activeProjectId === 'string' ? data.activeProjectId : '';
      this.categories = Array.isArray(data.categories) ? data.categories : [];
      this.renderProjects();
    } catch (error) {
      if (version !== this.requestVersion) return;
      this.renderProjectError(error.message || '剧本读取失败');
    }
  },

  renderProjects() {
    const projects = this.projects.filter(project => project.id !== INSPIRATION_PROJECT_ID);
    const list = this.el.scriptProjectList;
    list.replaceChildren();
    list.setAttribute('aria-busy', 'false');
    this.el.scriptProjectCount.textContent = projects.length ? `${projects.length} 个剧本` : '暂无剧本';
    this.el.inspirationProject.classList.toggle('current', this.activeProjectId === INSPIRATION_PROJECT_ID);
    this.el.inspirationProject.setAttribute('aria-current', this.activeProjectId === INSPIRATION_PROJECT_ID ? 'true' : 'false');

    if (!projects.length) {
      list.appendChild(h('div', { class: 'script-project-state empty' },
        h('strong', {}, '还没有正式剧本'),
        h('span', {}, '可以先进入灵感生成，或在下方新建一个剧本。'),
      ));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const project of projects) {
      const name = String(project.name || project.title || '未命名剧本').trim() || '未命名剧本';
      const current = project.id === this.activeProjectId;
      fragment.appendChild(h('button', {
        class: `script-project-option${current ? ' current' : ''}`,
        type: 'button',
        'aria-current': current ? 'true' : 'false',
        title: name,
        onclick: () => this.activateProject(project.id, name),
      },
        h('span', { class: 'script-project-symbol', html: ICONS.script, 'aria-hidden': 'true' }),
        h('span', { class: 'script-project-copy' },
          h('strong', {}, name),
          h('small', {}, current ? '当前剧本 · 图片和视频共享此工作区' : '图片和视频共享此剧本工作区'),
        ),
        current ? h('span', { class: 'script-current-badge' }, '当前') : h('span', { class: 'script-entry-arrow', 'aria-hidden': 'true' }, '›'),
      ));
    }
    list.appendChild(fragment);
  },

  renderProjectError(message) {
    const list = this.el.scriptProjectList;
    list.setAttribute('aria-busy', 'false');
    this.el.scriptProjectCount.textContent = '读取失败';
    list.replaceChildren(h('div', { class: 'script-project-state error', role: 'alert' },
      h('strong', {}, '无法读取最近剧本'),
      h('span', {}, message),
      h('button', { class: 'shell-btn secondary', type: 'button', onclick: () => this.loadProjects() }, '重试'),
    ));
  },

  async activateProject(projectId, projectName) {
    if (this.busy || !projectId) return;
    const version = ++this.actionVersion;
    this.setBusy(true, `正在进入「${projectName}」…`);
    try {
      const data = await requestJson('/api/creative-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'activate', id: projectId }),
      });
      if (version !== this.actionVersion || !this.el.scriptChooser.open) return;
      if (data?.ok === false) throw new Error(data.message || '剧本切换失败');
      const project = data?.project || this.projects.find(item => item.id === projectId) || { id: projectId, name: projectName };
      await this.launchProject(project);
    } catch (error) {
      if (version !== this.actionVersion || !this.el.scriptChooser.open) return;
      this.setBusy(false);
      this.setStatus(`无法进入「${projectName}」：${error.message}`, { error: true });
    }
  },

  async createProject() {
    if (this.busy) return;
    const name = this.el.newProjectName.value.trim();
    if (!name) {
      this.setStatus('请先填写剧本名称。', { error: true });
      this.el.newProjectName.focus();
      return;
    }
    const version = ++this.actionVersion;
    this.setBusy(true, `正在创建「${name}」…`);
    try {
      const data = await requestJson('/api/creative-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create', name }),
      });
      if (version !== this.actionVersion || !this.el.scriptChooser.open) return;
      if (data?.ok === false) throw new Error(data.message || '剧本创建失败');
      const project = data?.project || (data?.projects || []).find(item => item.id === data?.activeProjectId);
      if (!project?.id) throw new Error('服务器没有返回新剧本信息');
      await this.launchProject(project);
    } catch (error) {
      if (version !== this.actionVersion || !this.el.scriptChooser.open) return;
      this.setBusy(false);
      this.setStatus(`新建失败：${error.message}`, { error: true });
      this.el.newProjectName.focus();
    }
  },

  async launchProject(project) {
    const projectId = String(project?.id || '');
    const projectName = String(project?.name || project?.title || (projectId === INSPIRATION_PROJECT_ID ? '灵感生成' : '当前剧本'));
    this.activeProjectId = projectId;
    this.close({ immediate: true, restoreFocus: false });
    this.setBusy(false);
    if (!window.desktopOS?.isElectron) {
      toast(`已选择「${projectName}」；内嵌创作平台需要桌面版`);
      return;
    }
    try {
      await window.desktopOS.openCreatorBrowser({ mode: this.preferredMode, projectId });
      toast(`已进入「${projectName}」${this.preferredMode === 'video' ? '视频' : '图片'}工作台`);
    } catch (error) {
      toast('创作浏览器打开失败：' + error.message);
    }
  },
};

const CreatorApp = {
  id: 'creator', title: '创作工作台', pageTitle: '创作工作台', eyebrow: 'GENERATION STUDIO', subtitle: '在常用 AI 网页创作，按剧本管理素材', icon: ICONS.creator, width: 900, height: 590,
  mount(root) {
    const isDesktop = !!window.desktopOS?.isElectron;
    const openMode = mode => CreatorEntry.open({ preferredMode: mode });
    const externalLink = (label, url) => h('a', {
      class: 'creator-platform-link', href: url, target: '_blank', rel: 'noopener noreferrer',
    }, label, h('span', { 'aria-hidden': 'true' }, '↗'));
    const lane = ({ mode, title, system, description, archive, platforms, identifier }) => h('section', {
      class: `creator-lane ${mode}`, 'data-mode': mode,
    },
      h('div', { class: 'creator-lane-head' },
        h('div', { class: 'creator-lane-identifier' },
          h('img', { src: identifier, alt: `${title}模块标识`, loading: 'eager', decoding: 'async' }),
        ),
        h('div', { class: 'creator-lane-heading' },
          h('span', { class: 'creator-lane-eyebrow' }, system),
          h('h3', {}, title),
        ),
      ),
      h('p', { class: 'creator-lane-copy' }, description),
      h('div', { class: 'creator-archive' },
        h('b', {}, '归档'),
        h('small', {}, archive),
      ),
      h('div', { class: 'creator-platforms' }, ...platforms.map(([label, url]) => externalLink(label, url))),
      h('button', { class: 'creator-launch', onclick: () => openMode(mode) },
        isDesktop ? `选择剧本并进入${mode === 'image' ? '图片' : '视频'}模式` : '选择剧本',
        h('span', { 'aria-hidden': 'true' }, '→'),
      ),
    );

    root.replaceChildren(h('div', { class: 'creator-launcher' },
      h('header', { class: 'creator-launcher-head' },
        h('div', { class: 'creator-launcher-copy' },
          h('h2', {}, '让每一次生成，', h('br'), '都从清楚的创作意图开始'),
          h('p', {}, '先选择剧本工作区；图片与视频共享人物、场景、首尾帧和生成记录。'),
          h('span', { class: `creator-desktop-status ${isDesktop ? 'ready' : ''}` },
            isDesktop ? '桌面创作浏览器已就绪' : '浏览器预览模式',
          ),
        ),
      ),
      h('div', { class: 'creator-lanes' },
        lane({
          mode: 'image', title: '图片设计', system: 'IMAGE SYSTEM', identifier: 'assets/ui/creator/image-3d-v1.png',
          description: '角色、服装、场景、首帧与色卡。',
          archive: 'Obsidian · 浏览器生成',
          platforms: [['GPT 图片', 'https://chatgpt.com/'], ['Midjourney', 'https://www.midjourney.com/'], ['核绘', HEHUI_PROJECT_URL]],
        }),
        lane({
          mode: 'video', title: '视频设计', system: 'VIDEO SYSTEM', identifier: 'assets/ui/creator/video-3d-v1.png',
          description: '镜头动作、对白、时长与尾帧连续性。',
          archive: '素材库 · 浏览器生成',
          platforms: [['GPT 提示词', 'https://chatgpt.com/'], ['Updream', 'https://www.updream.cn/'], ['小云雀', 'https://xyq.jianying.com/'], ['核绘', HEHUI_PROJECT_URL]],
        }),
      ),
    ));
  },
};



/* ---------- 应用：资产中心 / 创作资产 ---------- */
const CreativeAssetsApp = {
  id: 'creative-assets', title: '创作资产', pageTitle: '创作资产', eyebrow: 'ASSET CENTER',
  subtitle: '生成前输入 · 角色、场景、色卡、音频与视频参考',
  icon: ICONS.creativeAssets,
  width: 1180, height: 720,
  mount(root) {
    const frame = h('iframe', {
      class: 'creative-assets-frame',
      src: 'creator-assets.html?surface=library',
      title: '创作资产库',
      loading: 'eager',
    });
    root.replaceChildren(h('div', { class: 'creative-assets-app' },
      h('aside', { class: 'asset-center-note' },
        h('span', { 'aria-hidden': 'true' }, 'i'),
        h('p', {},
          h('strong', {}, '导入一次，各栏目自动收录。'),
          ' 工作台的图片、视频和音频会同步到媒体索引与音频素材，原文件仍按剧本保存；确认的最终视频才进入成片库。',
        ),
        h('button', { class: 'text-link', type: 'button', onclick: () => window.AssetSources.open() }, '外部来源'),
      ),
      frame,
    ));
  },
};

/* ---------- 应用：帮助 ---------- */
const HelpApp = {
  id: 'help', title: '使用说明', pageTitle: '使用说明', eyebrow: 'HELP', subtitle: '本机工作流、数据边界与快捷键', icon: ICONS.help,
  width: 620, height: 520,
  mount(root) {
    const body = h('div', { class: 'md-body', style: 'overflow-y:auto;height:100%' });
    renderMD(`## 欢迎使用 视频制作 OS

一套跑在本机项目文件夹上的「创作操作系统」，集中管理素材、音频、经验和蒸馏知识：



### 📦 资产中心
- **创作资产**与**视频素材、音频素材、成片、Obsidian 资产**统一放在侧栏“资产中心”类别中，入口和操作语言保持一致。
- 创作资产保存在项目根目录的 \`创作资产库\`，用于生成前反复引用的角色图、场景图、色卡、参考音频、参考视频和文档；可按剧本建立上下级文件夹。
- 工作台上传、拖入和归档到 \`创作资产库\` 的图片、视频、音频，自动收录到媒体索引与音频素材；按原剧本和文件夹保留归属，无需再次上传。
- 原 \`素材库\` 与手动添加的 Downloads 等目录继续保留索引；只读取原文件，不搬动或复制。视频明确标记为成品后才进入成片库。
- 点缩略图全屏预览，视频可直接拖进度条播放。
- 可给素材 **收藏 ★**、**标记为成品**、写备注，全部自动保存在 \`视频制作OS/data/asset-meta.json\`。
- 既有 Obsidian 人物、服装、场景和色卡仍以只读索引保留，可逐步把高频引用内容预存到创作资产库。

### 🎵 音频库
- 自动汇总 \`素材库\` 与各剧本 \`创作资产库\` 中的音频，工作台导入后自动刷新。
- 支持按实际父目录分组、名称或路径搜索、修改时间／名称／大小／文件夹排序。
- 每条音频可直接播放，并复用素材库的收藏、标签、备注和 Finder／文件夹定位能力。

### 💎 Obsidian 索引
- 只读连接当前本机 Obsidian Vault，原样显示 **文件夹 → 子文件夹 → 文件** 的上下级关系。
- 分类只使用文件夹名和文件名，不分析笔记正文，不要求额外属性或命名规范。
- 点击 Markdown 笔记可按原顺序阅读文本与嵌入图片；粘贴图片仍保存在原 Vault 中。
- 名称搜索只搜索文件夹和文件名，点击「刷新索引」读取 Obsidian 的最新变化。

### 🧠 Agent 经验库
- 收录模型信息（Seedance 2.0 / Fast、GPT 生图、Grok）、提示词模板、规范流程和长期偏好。
- 所有分类的卡片默认只显示单行标题，点击标题展开完整内容，再次点击即可收起。
- 每张卡片可 **一键复制**；「新对话开场包」直接粘贴到新对话，让 Agent 立刻进入工作状态。
- 卡片可在线编辑，保存到 \`视频制作OS/data/agent-knowledge.json\`。

### ◫ 创作浏览器工作台
- 分为 **图片模式** 与 **视频模式**：两套提示词草稿、检查项、平台标签和下载列表分别保存。
- 图片模式可使用 GPT / Midjourney / 核绘，下载图片自动归档到 Obsidian 的 \`ai创作短剧/韩剧制作/浏览器生成\`。
- 视频模式可使用 GPT / Updream / 小云雀 / 核绘，下载视频和音频自动归档到项目 \`素材库/浏览器生成\`，并刷新本站索引。
- 右侧“创作资产库”可按剧本与下级文件夹预存图片、音频、视频和文档；桌面版可直接拖到创作平台。
- 各平台网页登录状态持久保留；如果某个平台阻止内嵌登录，可以点「系统浏览器打开」继续使用。

### 📚 蒸馏文库
- 自动读取根目录所有 \`VIDEO-NNN\`、\`TOOL-NNN\` 蒸馏文档，并解析 \`MEMORY-MANIFEST.md\` 的用途与优先章节。
- 支持全文渲染、大纲锚点、代码块复制、全文复制；未登记进清单的文档会标「未登记」提醒。

### 🔍 全局搜索
- 顶部搜索框或 **⌘K**：同时搜素材、项目知识和 Agent 规则。

### 启动方式
Mac 桌面完整版双击项目里的 \`视频制作OS/启动OS-mac.command\`；首次使用先运行 \`安装桌面版依赖-mac.command\`。开发时也可以在终端运行：

    cd 视频制作OS && npm run desktop

本地服务器只监听本机（127.0.0.1）。提示词在 GPT 等网页中制作，软件不要求拆解文件或镜头台账。创作浏览器只访问你主动打开的第三方网页，只有你在这些平台提交或上传的内容会交给对应平台。`, body);
    root.replaceChildren(body);
  },
};

/* ---------- 应用：总览 / 项目库 / 成片库 ---------- */
const dashboardMediaCard = (file, list) => {
  const meta = file.meta || {};
  const thumb = file.type === 'video'
    ? h('video', { src: fileUrl(file.path), muted: 'muted', preload: 'metadata', tabindex: '-1' })
    : file.type === 'image'
      ? h('img', { src: fileUrl(file.path), alt: '', loading: 'lazy', decoding: 'async' })
      : h('span', { class: 'recent-audio-glyph', html: ICONS.audio, 'aria-hidden': 'true' });
  return h('button', {
    class: 'recent-card', type: 'button', title: file.path,
    onclick: () => Lightbox.open(file, null, null, list),
  },
    h('span', { class: `recent-preview ${file.type}` },
      thumb,
      h('span', { class: `recent-kind ${file.type}` }, TYPE_NAME[file.type] || '文件'),
      meta.isFinal ? h('span', { class: 'recent-final' }, '成片') : null,
    ),
    h('span', { class: 'recent-copy' },
      h('strong', {}, file.name),
      h('small', {}, `${parentFolderOf(file.displayPath || file.path)} · ${fmtDate(file.mtime)}`),
    ),
  );
};

const OverviewApp = {
  id: 'overview', title: '总览', pageTitle: '视频制作总览', eyebrow: 'CONTENT PRODUCTION', subtitle: '网页创作、分剧本素材与成片归档',
  icon: ICONS.overview,
  mount(root, win) { this.render(root, win); },
  render(root) {
    const scan = Store.scan;
    if (!scan) {
      root.replaceChildren(h('div', { class: 'overview-loading', role: 'status' }, '正在读取本地索引…'));
      return;
    }
    const visible = scan.files.filter(file => !file.hidden && !(file.meta && file.meta.rejected));
    const videos = visible.filter(file => file.type === 'video');
    const audios = visible.filter(file => file.type === 'audio');
    const finals = videos.filter(file => file.meta && file.meta.isFinal === true);
    const recent = sortAssets(visible, 'newest').slice(0, 8);
    const docs = scan.docs.length;

    const stat = (value, label, route, countKey) => h('button', {
      class: 'overview-stat', type: 'button', onclick: () => WM.open(route),
    }, h('strong', { 'data-stat': countKey || '' }, String(value)), h('span', {}, label));

    const recentSection = recent.length
      ? h('div', { class: 'recent-grid' }, ...recent.map(file => dashboardMediaCard(file, recent)))
      : h('div', { class: 'recent-empty' },
        h('div', { class: 'recent-empty-mark', html: ICONS.import, 'aria-hidden': 'true' }),
        h('div', {},
          h('strong', {}, '还没有媒体'),
          h('p', {}, '添加 Downloads、其他媒体目录，或从创作浏览器生成。'),
        ),
        h('div', { class: 'recent-empty-actions' },
          h('button', { class: 'shell-btn secondary', type: 'button', onclick: () => WM.open('assets') }, '打开媒体索引'),
        ),
      );

    root.replaceChildren(h('div', { class: 'overview-app' },
      h('section', { class: 'overview-hero' },
        h('div', { class: 'hero-copy' },
          h('span', { class: 'hero-kicker' }, '你的本地创作空间'),
          h('h2', {}, '专注创作，', h('br'), '让素材各归其位'),
          h('p', {}, '在 GPT 等网页中准备提示词，图片、视频和音频按剧本保存。'),
          h('div', { class: 'hero-actions' },
            h('button', { class: 'hero-btn light', type: 'button', onclick: () => CreatorEntry.open({ preferredMode: 'image' }) }, '进入创作'),
            h('button', { class: 'hero-btn ghost', type: 'button', onclick: () => WM.open('creative-assets') }, '打开创作资产 →'),
          ),
        ),
        h('div', { class: 'overview-system-map', 'aria-label': '创作系统' },
          h('button', { class: 'overview-system-card image', type: 'button', onclick: () => CreatorEntry.open({ preferredMode: 'image' }) },
            h('span', { class: 'overview-system-identifier' },
              h('img', { src: 'assets/ui/creator/image-3d-v1.png', alt: '', loading: 'eager', decoding: 'async' }),
            ),
            h('span', { class: 'overview-system-copy' },
              h('small', {}, 'IMAGE SYSTEM'),
              h('strong', {}, '图片设计'),
            ),
            h('span', { class: 'overview-system-arrow', 'aria-hidden': 'true' }, '↗'),
          ),
          h('button', { class: 'overview-system-card video', type: 'button', onclick: () => CreatorEntry.open({ preferredMode: 'video' }) },
            h('span', { class: 'overview-system-identifier' },
              h('img', { src: 'assets/ui/creator/video-3d-v1.png', alt: '', loading: 'eager', decoding: 'async' }),
            ),
            h('span', { class: 'overview-system-copy' },
              h('small', {}, 'VIDEO SYSTEM'),
              h('strong', {}, '视频设计'),
            ),
            h('span', { class: 'overview-system-arrow', 'aria-hidden': 'true' }, '↗'),
          ),
        ),
      ),
      h('section', { class: 'overview-stats', 'aria-label': '真实索引统计' },
        stat(visible.filter(file => file.type === 'image').length, '图片素材', 'assets', 'images'),
        stat(videos.length, '视频素材', 'assets', 'videos'),
        stat(finals.length, '已标记成片', 'finals', 'finals'),
        stat(audios.length, '音频素材', 'audio', 'audio'),
        stat(docs, '项目知识文档', 'distill', 'docs'),
      ),
      h('section', { class: 'overview-recent' },
        h('div', { class: 'section-heading' },
          h('div', {}, h('h2', {}, '最近入库')),
          h('div', { class: 'recent-source' },
            h('button', { class: 'text-link', type: 'button', onclick: () => WM.open('assets') }, '查看全部媒体 →'),
          ),
        ),
        recentSection,
      ),
    ));
  },
};



const FinalsApp = {
  id: 'finals', title: '成片库', pageTitle: '成片库', eyebrow: 'APPROVED OUTPUTS', subtitle: '按剧本归档的成片与指定目录',
  icon: ICONS.projects,
  async mount(root, win) { win.state.project = 'all'; await Store.loadScan(); this.render(root, win); },
  render(root, win) {
    const scan = Store.scan;
    const selected = win?.state.project || 'all';
    const finals = scan ? sortAssets(scan.files.filter(file => !file.hidden && file.type === 'video' && file.meta?.isFinal && !file.meta.rejected
      && (selected === 'all' || LibraryView.projectKey(file) === selected)), 'newest') : [];
    const sources = (scan?.sources || []).filter(source => source.purpose === 'finals');
    root.replaceChildren(h('div', { class: 'library-page finals-page' },
      h('header', { class: 'library-intro compact-library-intro' },
        h('h2', {}, `成片 ${finals.length}`),
        LibraryView.select(selected, value => { win.state.project = value; this.render(root, win); }),
        h('button', { class: 'btn primary', onclick: () => window.EditorExports.open({ projectId: selected }) }, '剪映导出'),
        h('button', { class: 'btn', onclick: () => LibraryView.configure('finals') }, '＋ 关联成片文件夹'),
        h('button', { class: 'btn', onclick: () => refreshMediaLibraries().catch(error => toast(error.message)) }, '刷新'),
      ),
      sources.length ? h('div', { class: 'linked-final-folders' }, ...sources.map(source =>
        h('button', { class: 'btn small', onclick: () => LibraryView.configure('finals', source.id) },
          `${source.label} · ${(scan.projects || []).find(project => project.id === source.projectId)?.name || '未归属'}${source.available ? '' : ' · 离线'}`))) : null,
      finals.length ? h('div', { class: 'grouped-finals' }, ...LibraryView.groups(finals, file => dashboardMediaCard(file, finals), 'finals-grid'))
        : h('div', { class: 'library-empty' },
          h('span', { class: 'library-empty-mark', html: ICONS.film, 'aria-hidden': 'true' }),
          h('h3', {}, '把第一条成片导出到这里'),
          h('p', {}, '复制本剧成片目录，设为剪映的导出位置，完成后自动收录。'),
          h('button', { class: 'btn primary', onclick: () => window.EditorExports.open({ projectId: selected }) }, '设置导出位置'),
        ),
    ));
  },
};

const APPS = {};
[OverviewApp, FinalsApp, CreatorApp, CreativeAssetsApp, AssetsApp, AudioApp, ObsidianApp, DistillApp, AgentApp, HelpApp]
  .forEach(a => APPS[a.id] = a);

const SHELL_NAV_GROUPS = [
  { label: '创作', items: [['creator-image', '图片创作'], ['creator-video', '视频创作']] },
  { label: '资产中心', items: [['creative-assets', '本剧资产'], ['assets', '图片与视频'], ['audio', '音频素材'], ['finals', '成片库'], ['asset-sources', '外部来源']] },
];
// 低频模块收进「更多功能」，默认折叠。
const SHELL_NAV_MORE_ITEMS = [
  ['overview', '总览'], ['distill', '项目知识'], ['agent', 'Agent 与规则'], ['help', '使用说明'],
];
const SHELL_NAV_MORE_KEY = 'videoOS.nav.showMore.v1';
const SHELL_NAV_COUNT_KEYS = { assets: 'assets', audio: 'audio', finals: 'finals', distill: 'distill', obsidian: 'obsidian' };

function openSidebar() {
  const sidebar = $('#sidebar');
  const scrim = $('#sideScrim');
  const button = $('#menuBtn');
  if (!sidebar || !scrim || !button) return;
  sidebar.classList.add('open');
  scrim.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  const sidebar = $('#sidebar');
  const scrim = $('#sideScrim');
  const button = $('#menuBtn');
  if (!sidebar || !scrim || !button) return;
  sidebar.classList.remove('open');
  scrim.classList.add('hidden');
  button.setAttribute('aria-expanded', 'false');
}

function navItemButton(id, label) {
  const app = APPS[id];
  const countKey = SHELL_NAV_COUNT_KEYS[id] || null;
  const opensCreator = id === 'creator-image' || id === 'creator-video';
  const icon = id === 'creator-image' ? ICONS.image
    : id === 'creator-video' ? ICONS.video : id === 'asset-sources' ? ICONS.obsidian : app?.icon || ICONS.doc;
  return h('button', {
    class: 'side-nav-item', type: 'button', 'data-app': id,
    onclick: () => opensCreator
      ? CreatorEntry.open({ preferredMode: id === 'creator-video' ? 'video' : 'image' })
      : id === 'asset-sources' ? window.AssetSources.open() : WM.open(id),
  },
    h('span', { class: 'side-nav-icon', html: icon, 'aria-hidden': 'true' }),
    h('span', { class: 'side-nav-text' }, label),
    countKey ? h('span', { class: 'side-nav-count', 'data-app-count': countKey }, '0') : null,
  );
}

function buildSideNav() {
  const nav = $('#sideNav');
  nav.replaceChildren();
  for (const group of SHELL_NAV_GROUPS) {
    const section = h('section', { class: 'side-nav-group' });
    if (group.label) section.appendChild(h('div', { class: 'side-nav-label' }, group.label));
    for (const [id, label] of group.items) section.appendChild(navItemButton(id, label));
    nav.appendChild(section);
  }
  const showMore = localStorage.getItem(SHELL_NAV_MORE_KEY) === '1';
  const moreSection = h('section', { class: 'side-nav-group side-nav-more' + (showMore ? '' : ' collapsed') });
  const moreItems = h('div', { class: 'side-nav-more-items' });
  for (const [id, label] of SHELL_NAV_MORE_ITEMS) moreItems.appendChild(navItemButton(id, label));
  const toggle = h('button', {
    class: 'side-nav-item side-nav-more-toggle', type: 'button', 'aria-expanded': String(showMore),
    onclick: () => {
      const next = moreSection.classList.contains('collapsed');
      moreSection.classList.toggle('collapsed', !next);
      toggle.setAttribute('aria-expanded', String(next));
      try { localStorage.setItem(SHELL_NAV_MORE_KEY, next ? '1' : '0'); } catch {}
    },
  },
    h('span', { class: 'side-nav-icon', 'aria-hidden': 'true' }, '⋯'),
    h('span', { class: 'side-nav-text' }, '更多功能'),
  );
  moreSection.append(toggle, moreItems);
  nav.appendChild(moreSection);
}

/* ---------- 灯箱 ---------- */
const Lightbox = {
  current: null,
  onChange: null,
  list: null,      // 打开时的同级列表，用于上一条/下一条
  index: -1,
  asDocFlag: false,
  async open(f, onChange, asDoc, list) {
    this.current = f;
    this.onChange = onChange || null;
    this.asDocFlag = !!asDoc;
    this.list = Array.isArray(list) ? list : null;
    this.index = this.list ? this.list.findIndex(x => x.path === f.path) : -1;
    const hasList = !!(this.list && this.list.length > 1 && this.index >= 0);
    $('#lbPrev').style.display = hasList ? '' : 'none';
    $('#lbNext').style.display = hasList ? '' : 'none';
    $('#lbCount').textContent = hasList ? `${this.index + 1} / ${this.list.length}` : '';
    $('#lightbox').classList.remove('hidden');
    $('#lbName').textContent = f.name;
    const meta = f.meta || {};
    $('#lbMeta').innerHTML =
      `<b>类型</b>：${TYPE_NAME[f.type] || '文档'}${meta.isFinal ? ' · <b style="color:var(--gold)">成品</b>' : ''}${meta.rejected ? ' · <b style="color:var(--accent)">废片</b>' : ''}<br>` +
      `<b>大小</b>：${f.sizeText} <span id="lbDur"></span><br><b>修改</b>：${fmtDate(f.mtime)}<br><b>路径</b>：${esc(f.path)}` +
      (meta.note ? `<br><b>备注</b>：${esc(meta.note)}` : '');
    $('#lbStar').textContent = meta.starred ? '★ 已收藏' : '☆ 收藏';
    $('#lbFinal').textContent = f.finalSource ? '由成片目录收录' : meta.isFinal ? '取消成品标记' : '标记为成品';
    $('#lbFinal').disabled = !!f.finalSource;
    $('#lbReject').textContent = meta.rejected ? '↩ 恢复（取消废片）' : '✕ 标为废片';
    $('#lbUse').hidden = !!asDoc || !['image', 'video', 'audio'].includes(f.type);
    $('#lbNoteArea').value = meta.note || '';

    // 评分
    $('#lbRating').replaceChildren(
      h('span', { class: 'lb-rating-label' }, '评分'),
      ratingWidget(meta.rating || 0, async v => {
        const item = await Store.setMeta(f.path, { rating: v });
        f.meta = item;
        toast(v ? `已评 ${v} 星` : '已清除评分');
      }),
    );

    // 生成来源提示词（血缘 sidecar）
    const sidecarBox = $('#lbSidecar');
    sidecarBox.classList.add('hidden');
    if (f.type === 'video' || f.type === 'audio') {
      try {
        const sc = await requestJson(`/api/prompt-sidecar?p=${encodeURIComponent(f.path)}`);
        if (sc && sc.found && sc.content) {
          $('#lbSidecarBody').textContent = sc.content;
          sidecarBox.classList.remove('hidden');
        }
      } catch {}
    }

    // 标签
    const tagsBox = $('#lbTags');
    tagsBox.replaceChildren();
    if (meta.tags && meta.tags.length) {
      for (const t of meta.tags) {
        tagsBox.appendChild(h('span', { class: 'lb-tag' },
          t,
          h('button', { class: 'lb-tag-x', onclick: async () => {
            try {
              const m = f.meta || {};
              const newTags = (m.tags || []).filter(x => x !== t);
              f.meta = await Store.setMeta(f.path, { tags: newTags });
              Lightbox.open(f, Lightbox.onChange, Lightbox.asDocFlag, Lightbox.list);
              toast('标签已移除');
            } catch (err) { toast('标签保存失败：' + err.message); }
          }}, '✕'),
        ));
      }
    }

    const stage = $('#lbStage');
    stage.replaceChildren();
    if (asDoc || (f.type === 'doc')) {
      requestJson(`/api/doc?p=${encodeURIComponent(f.path)}`)
        .then(data => {
          if (!data || typeof data.content !== 'string') throw new Error('文档数据格式无效');
          const box = h('div', { class: 'md-body', style: 'padding:22px 26px' });
          renderMD(data.content, box);
          stage.replaceChildren(box);
        })
        .catch(err => stage.replaceChildren(errorView('文档读取失败：' + err.message)));
    } else if (f.type === 'image') {
      stage.appendChild(h('img', { src: fileUrl(f.path), alt: f.name }));
    } else if (f.type === 'video') {
      const vid = h('video', { src: fileUrl(f.path), controls: true, preload: 'metadata' });
      vid.addEventListener('loadedmetadata', () => { $('#lbDur').textContent = `时长 ${fmtDur(vid.duration)}`; });
      stage.appendChild(vid);
    } else if (f.type === 'audio') {
      const aud = h('audio', { src: fileUrl(f.path), controls: true, preload: 'metadata' });
      aud.addEventListener('loadedmetadata', () => { $('#lbDur').textContent = `时长 ${fmtDur(aud.duration)}`; });
      stage.appendChild(h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:14px' },
        h('span', { class: 'lb-audio-art', html: ICONS.audio, 'aria-hidden': 'true' }),
        aud,
      ));
    }
  },
  close() {
    $('#lightbox').classList.add('hidden');
    $('#lbStage').replaceChildren();
    if (this.onChange) this.onChange();
    this.onChange = null;
  },
  nav(dir) {
    if ($('#lightbox').classList.contains('hidden')) return;
    if (!this.list || this.index < 0 || this.list.length < 2) return;
    const next = (this.index + dir + this.list.length) % this.list.length;
    const f = this.list[next];
    if (f) this.open(f, this.onChange, this.asDocFlag, this.list);
  },
  async patch(what) {
    const f = this.current;
    if (!f) return;
    const cur = f.meta || {};
    const patch = what === 'star' ? { starred: !cur.starred }
      : what === 'final' ? { isFinal: !cur.isFinal }
      : what === 'reject' ? { rejected: !(cur.rejected) }
      : { note: $('#lbNoteArea').value };
    try {
      const item = await Store.setMeta(f.path, patch);
      f.meta = item;
      this.open(f, this.onChange, this.asDocFlag, this.list); // 刷新侧栏显示
    } catch (err) { toast('素材标记保存失败：' + err.message); }
  },
};

/* ---------- 对比视图：多素材并排比较 ---------- */
const CompareBox = {
  onChange: null,
  open(files, onChange) {
    this.onChange = onChange || null;
    const list = files.slice(0, 9);
    $('#cmpTitle').textContent = `并排对比 ${list.length} 项`;
    const grid = $('#cmpGrid');
    grid.replaceChildren();
    for (const f of list) grid.appendChild(this.cell(f));
    $('#compareBox').classList.remove('hidden');
  },
  cell(f) {
    let media;
    if (f.type === 'video') media = h('video', { src: fileUrl(f.path), controls: true, preload: 'metadata' });
    else if (f.type === 'audio') media = h('audio', { src: fileUrl(f.path), controls: true, preload: 'metadata' });
    else media = h('img', { src: fileUrl(f.path), alt: f.name });
    const dur = h('span', { class: 'cmp-dur' });
    if (media.tagName === 'VIDEO' || media.tagName === 'AUDIO') {
      media.addEventListener('loadedmetadata', () => { dur.textContent = fmtDur(media.duration); });
    }
    const meta = f.meta || {};
    const cellEl = h('div', { class: 'cmp-cell' + (meta.rejected ? ' rejected' : '') },
      h('div', { class: 'cmp-media' }, media, dur),
      h('div', { class: 'cmp-name', title: f.path }, f.name),
      h('div', { class: 'cmp-row' },
        ratingWidget(meta.rating || 0, async v => {
          f.meta = await Store.setMeta(f.path, { rating: v });
          toast(v ? `已评 ${v} 星` : '已清除评分');
        }),
        h('button', {
          class: 'btn small',
          onclick: async () => {
            f.meta = await Store.setMeta(f.path, { starred: !(f.meta && f.meta.starred) });
            const fresh = CompareBox.cell(f);
            cellEl.replaceChildren(...fresh.childNodes);
          },
        }, meta.starred ? '★ 已收藏' : '☆ 收藏'),
        h('button', {
          class: 'btn small',
          onclick: async () => {
            f.meta = await Store.setMeta(f.path, { rejected: !(f.meta && f.meta.rejected) });
            cellEl.classList.toggle('rejected', !!f.meta.rejected);
            toast(f.meta.rejected ? '已标为废片' : '已恢复');
          },
        }, '废片切换'),
      ),
    );
    return cellEl;
  },
  playAll() {
    $$('#cmpGrid video').forEach(v => { v.muted = false; v.play().catch(() => { v.muted = true; v.play().catch(() => {}); }); });
    $$('#cmpGrid audio').forEach(a => a.play().catch(() => {}));
  },
  close() {
    $$('#cmpGrid video, #cmpGrid audio').forEach(m => m.pause());
    $('#compareBox').classList.add('hidden');
    if (this.onChange) this.onChange();
    this.onChange = null;
  },
};

/* ---------- 全局搜索 ---------- */
const SearchPanel = {
  renderId: 0,
  items: [],      // 扁平结果列表，供键盘导航
  selIdx: -1,
  open() {
    $('#searchPanel').classList.remove('hidden');
    const inp = $('#spInput');
    inp.value = '';
    inp.focus();
    this.items = [];
    this.selIdx = -1;
    this.render('');
  },
  close() { $('#searchPanel').classList.add('hidden'); },
  move(dir) {
    if (!this.items.length) return;
    this.selIdx = (this.selIdx + dir + this.items.length) % this.items.length;
    this.paintSelection();
  },
  paintSelection() {
    this.items.forEach((item, i) => item.el.classList.toggle('sel', i === this.selIdx));
    const cur = this.items[this.selIdx];
    if (cur && cur.el.scrollIntoView) cur.el.scrollIntoView({ block: 'nearest' });
  },
  enter() {
    const cur = this.items[this.selIdx];
    if (cur) cur.click();
  },
  async render(q) {
    const renderId = ++this.renderId;
    const box = $('#spResults');
    box.replaceChildren(h('div', { class: 'empty-tip' }, q ? '搜索中…' : '输入关键词：素材 / Obsidian / 项目知识 / Agent 规则（↑↓ 选择，回车打开）'));
    if (!q.trim()) return;
    try {
      await Promise.all([Store.loadScan(), Store.loadKnowledge(), Store.loadObsidianNotes()]);
    } catch (err) {
      if (renderId === this.renderId) box.replaceChildren(errorView('搜索失败：' + err.message));
      return;
    }
    if (renderId !== this.renderId) return;
    const ql = q.toLowerCase();
    const mark = text => {
      const i = text.toLowerCase().indexOf(ql);
      return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
    };
    this.items = [];
    this.selIdx = -1;
    const addItem = el => {
      // 让键盘回车能触发原 click 逻辑
      this.items.push({ el, click: () => el.dispatchEvent(new MouseEvent('click', { bubbles: true })) });
    };

    const files = Store.scan.files.filter(f => (!f.hidden || f.type === 'audio') &&
      (f.path + ' ' + ((f.meta && f.meta.note) || '') + ' ' + ((f.meta && f.meta.tags) || []).join(' ')).toLowerCase().includes(ql)).slice(0, 8);
    const notes = (Store.obsidianNotes || []).filter(n =>
      (n.name + ' ' + n.path).toLowerCase().includes(ql)).slice(0, 6);
    const docs = Store.scan.docs.filter(d =>
      (d.title + d.id + (d.manifest ? d.manifest.purpose : '') + d.summary).toLowerCase().includes(ql)).slice(0, 6);

    const kCards = [];
    for (const sec of Store.knowledge.sections) {
      for (const item of sec.items) {
        if ((item.title + item.body).toLowerCase().includes(ql)) {
          kCards.push({ sec, item });
          if (kCards.length >= 6) break;
        }
      }
      if (kCards.length >= 6) break;
    }

    if (!files.length && !notes.length && !docs.length && !kCards.length) {
      box.replaceChildren(h('div', { class: 'empty-tip' }, '没有找到「' + esc(q) + '」'));
      return;
    }
    box.replaceChildren();
    if (files.length) {
      box.appendChild(h('div', { class: 'sp-group-title' }, '素材'));
      for (const f of files) {
        const el = h('div', { class: 'sp-item', onclick: () => { this.close(); WM.open(f.type === 'audio' ? 'audio' : 'assets'); Lightbox.open(f, null); } },
          h('span', { html: ICONS[f.type] || ICONS.doc, style: 'display:flex' }),
          h('span', { class: 'sp-name', html: mark(f.name) }),
          h('span', { class: 'sp-sub' }, `${TYPE_NAME[f.type]} · ${f.sizeText}`),
        );
        addItem(el);
        box.appendChild(el);
      }
    }
    if (notes.length) {
      box.appendChild(h('div', { class: 'sp-group-title' }, 'Obsidian 笔记'));
      for (const n of notes) {
        const el = h('div', {
          class: 'sp-item',
          onclick: () => {
            this.close();
            WM.open('obsidian');
            ObsidianApp.openNoteByPath(n.path);
          },
        },
          h('span', { class: 'doc-id system' }, '笔记'),
          h('span', { class: 'sp-name', html: mark(n.name) }),
          h('span', { class: 'sp-sub', title: n.path }, n.path),
        );
        addItem(el);
        box.appendChild(el);
      }
    }
    if (docs.length) {
      box.appendChild(h('div', { class: 'sp-group-title' }, '蒸馏文档'));
      for (const d of docs) {
        const el = h('div', {
          class: 'sp-item',
          onclick: () => { this.close(); const w = WM.open('distill'); w.openTarget = d.path; DistillApp.openDoc(w.el.querySelector('.win-body'), w, d.path); },
        },
          h('span', { class: 'doc-id ' + d.group }, d.id),
          h('span', { class: 'sp-name', html: mark(d.title) }),
        );
        addItem(el);
        box.appendChild(el);
      }
    }

    if (kCards.length) {
      box.appendChild(h('div', { class: 'sp-group-title' }, 'Agent 经验'));
      for (const { sec, item } of kCards) {
        const el = h('div', {
          class: 'sp-item',
          onclick: () => { this.close(); const w = WM.open('agent'); w.openSection = sec.id; w.openCard = item.id; AgentApp.mount(w.el.querySelector('.win-body'), w); },
        },
          h('span', { class: 'tag pink' }, sec.name),
          h('span', { class: 'sp-name', html: mark(item.title) }),
        );
        addItem(el);
        box.appendChild(el);
      }
    }
  },
};

/* ---------- 启动 ---------- */
let mediaRefreshTask = null;
let mediaRefreshPending = false;
function refreshMediaLibraries() {
  mediaRefreshPending = true;
  if (mediaRefreshTask) return mediaRefreshTask;
  mediaRefreshTask = (async () => {
    do {
      mediaRefreshPending = false;
      await Store.loadScan(true);
      for (const id of ['overview', 'finals', 'assets', 'audio']) {
        const win = WM.windows.get(id);
        if (!win) continue;
        const body = win.el.querySelector('.win-body');
        if (!body) continue;
        const scrollTop = body.scrollTop;
        const playingAudio = [...body.querySelectorAll('audio')].filter(player => !player.paused)
          .map(player => ({ player, src: player.getAttribute('src') }));
        if (id === 'assets') {
          if (!win.state.grid) continue;
          AssetsApp.buildCollections(body, win);
          AssetsApp.buildToolbar(body, win);
        }
        if (id === 'audio' && !win.state.list) continue;
        APPS[id].render?.(body, win);
        for (const { player, src } of playingAudio) {
          const replacement = [...body.querySelectorAll('audio')].find(item => item.getAttribute('src') === src);
          if (replacement) { replacement.replaceWith(player); if (player.paused) player.play().catch(() => {}); }
          else player.pause();
        }
        body.scrollTop = scrollTop;
      }
    } while (mediaRefreshPending);
  })().finally(() => { mediaRefreshTask = null; });
  return mediaRefreshTask;
}

async function boot() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  document.documentElement.classList.toggle('is-electron', !!window.desktopOS?.isElectron);
  document.documentElement.classList.toggle('is-macos', isMac);
  const shortcutHint = $('#shortcutHint');
  if (shortcutHint) shortcutHint.textContent = isMac ? '⌘ K' : 'Ctrl K';
  WM.init();
  window.addEventListener('asset-library-used', () => refreshMediaLibraries().catch(error => toast(error.message)));

  // 创作浏览器与资产面板中的“切换剧本”复用主壳的同一个归属选择器。
  window.desktopOS?.onOpenProjectPicker?.(({ mode } = {}) => {
    CreatorEntry.open({ preferredMode: mode });
  });

  // 工作台下载与导入共用索引刷新；不重新挂载页面，保留当前筛选。
  if (window.desktopOS?.onDownloadComplete) {
    window.desktopOS.onDownloadComplete(async download => {
      try {
        await refreshMediaLibraries();
        if (String(download.kind || '').startsWith('image')) {
          const obsidianWindow = WM.windows.get('obsidian');
          if (obsidianWindow) await ObsidianApp.mount(obsidianWindow.el.querySelector('.win-body'), obsidianWindow);
        }
        toast(`素材索引已更新：${download.filename}`);
      } catch (error) {
        toast(`文件已下载，但索引刷新失败：${error.message}`);
      }
    });
  }

  // 固定侧栏：应用模块保持挂载，切换时仅显示当前工作区，避免丢失筛选与滚动状态。
  buildSideNav();
  $('#menuBtn').addEventListener('click', () => {
    if ($('#sidebar').classList.contains('open')) closeSidebar(); else openSidebar();
  });
  $('#sideScrim').addEventListener('click', closeSidebar);

  // 顶栏
  $('#tbHelpBtn').addEventListener('click', () => WM.open('help'));
  $('#createBtn').addEventListener('click', () => CreatorEntry.open({ preferredMode: 'image' }));
  $('#rescanBtn').addEventListener('click', async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '扫描中…';
    try {
      await refreshMediaLibraries();
      toast('索引已更新；原始文件未被修改');
    } catch (error) {
      toast('重新扫描失败：' + error.message);
    } finally {
      button.disabled = false;
      button.textContent = '重新扫描';
    }
  });
  const spDebounce = (() => { let t; return v => { clearTimeout(t); t = setTimeout(() => SearchPanel.render(v), 180); }; })();
  $('#spInput').addEventListener('input', e => spDebounce(e.target.value));
  $('#spInput').addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); SearchPanel.move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); SearchPanel.move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); SearchPanel.enter(); }
  });
  $('#tbSearch').addEventListener('input', e => {
    if (e.target.value.trim()) { SearchPanel.open(); $('#spInput').value = e.target.value; spDebounce(e.target.value); }
  });
  $('#searchPanel').addEventListener('click', e => { if (e.target.id === 'searchPanel') SearchPanel.close(); });

  // 灯箱
  $('#lbClose').addEventListener('click', () => Lightbox.close());
  $('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') Lightbox.close(); });
  $('#lbPrev').addEventListener('click', () => Lightbox.nav(-1));
  $('#lbNext').addEventListener('click', () => Lightbox.nav(1));
  $('#lbReject').addEventListener('click', () => Lightbox.patch('reject'));
  $('#lbSidecarCopy').addEventListener('click', () => {
    const text = $('#lbSidecarBody').textContent || '';
    if (text) copyText(text);
  });

  // 对比视图
  $('#cmpClose').addEventListener('click', () => CompareBox.close());
  $('#cmpPlay').addEventListener('click', () => CompareBox.playAll());
  $('#compareBox').addEventListener('click', e => { if (e.target.id === 'compareBox') CompareBox.close(); });
  $('#lbStar').addEventListener('click', () => Lightbox.patch('star'));
  $('#lbFinal').addEventListener('click', () => Lightbox.patch('final'));
  $('#lbCopyPath').addEventListener('click', () => { if (Lightbox.current) copyText(Lightbox.current.path); });
  $('#lbReveal').addEventListener('click', async () => {
    if (!Lightbox.current) return;
    try {
      const data = await requestJson(`/api/reveal?p=${encodeURIComponent(Lightbox.current.path)}`);
      toast(data && data.ok ? '已请求在文件管理器中显示' : ((data && data.message) || '当前系统不支持此操作'));
    } catch (err) { toast('打开文件管理器失败：' + err.message); }
  });
  $('#lbUse').addEventListener('click', () => {
    const file = Lightbox.current;
    if (!file) return;
    Lightbox.close();
    window.AssetSources.open({ file, projectId: file.projectId });
  });
  $('#lbNoteArea').addEventListener('change', () => Lightbox.patch('note'));
  $('#lbTagInput').addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inp = e.target;
    const tag = inp.value.trim();
    if (!tag || !Lightbox.current) return;
    const m = Lightbox.current.meta || {};
    const tags = [...new Set([...(m.tags || []), tag])];
    try {
      Lightbox.current.meta = await Store.setMeta(Lightbox.current.path, { tags });
      inp.value = '';
      Lightbox.open(Lightbox.current, Lightbox.onChange, Lightbox.asDocFlag, Lightbox.list);
      toast(`标签「${tag}」已添加`);
    } catch (err) { toast('标签保存失败：' + err.message); }
  });

  // 快捷键
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') { SearchPanel.close(); Lightbox.close(); CompareBox.close(); }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); SearchPanel.open(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const tag = document.activeElement && document.activeElement.tagName;
      // 焦点在输入框或媒体控件上时，方向键交给它们（视频快进、文本光标）
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'VIDEO' || tag === 'AUDIO') return;
      Lightbox.nav(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });

  // 素材文件夹监听：文件落盘后自动刷新索引（SSE）
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('audio-library', () => refreshMediaLibraries().catch(error => toast(error.message)));
    es.addEventListener('rescan', async () => {
      try {
        await refreshMediaLibraries();
      } catch (error) { toast(`素材索引刷新失败：${error.message}`); }
    });
    es.addEventListener('open', () => {
      // 断线重连后补上期间的素材变动；首次加载仍由 boot 负责。
      if (Store.scan) refreshMediaLibraries().catch(() => {});
    });

  } catch {}

  // 初始数据
  try {

    await Store.loadScan();
    const notes = await Store.loadObsidianNotes();
    const obsidianCount = document.querySelector('[data-app-count="obsidian"]');
    if (obsidianCount) obsidianCount.textContent = String(notes.length);
  } catch {
    const health = $('#indexHealth');
    const lastScan = $('#lastScan');
    if (health) health.textContent = '本地索引连接失败';
    if (lastScan) lastScan.textContent = '请确认 server.js 正在运行';
    toast('素材扫描失败，请确认 server.js 正在运行');
  }

  // 恢复上次工作模块；未知或已删除的路由回到总览。
  const initialRoute = WM.savedLayout?.active && APPS[WM.savedLayout.active] ? WM.savedLayout.active : 'creator';
  WM.open(initialRoute);
  const pickerMode = new URLSearchParams(location.search).get('projectPicker');
  if (['image', 'video'].includes(pickerMode)) {
    history.replaceState(null, '', location.pathname);
    CreatorEntry.open({ preferredMode: pickerMode });
  }

  // 关页前保存当前模块，供后续版本扩展会话恢复。
  window.addEventListener('beforeunload', () => WM.saveLayout());
}
boot();
