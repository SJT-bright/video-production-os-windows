'use strict';

const { randomUUID, createHash } = require('crypto');
const { editorOperation } = require('./automation-editor.cjs');
// Fixed page operations only. Website content is data, never executable instructions.
function snapshotInPage() {
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], .el-dialog, .ant-modal')].filter(visible);
  const scope = dialogs.at(-1) || document.body;
  const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const latest = assistants.at(-1);
  const nativeSelector = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="button"], video';
  const all = [...scope.querySelectorAll(nativeSelector + ',div,span,img')].filter(e => e.matches(nativeSelector)
    || (getComputedStyle(e).cursor === 'pointer' && !e.parentElement?.closest('button,a[href],[role="button"]')
      && (e.tagName === 'IMG' || [...e.children].every(c => !['DIV', 'SPAN'].includes(c.tagName)))));
  const available = all.filter(e => (visible(e) || e.matches('input[type="file"]')) && !e.matches('input[type="password"],input[type="hidden"]'));
  const priority = e => {
    if (e.matches('input,textarea,[contenteditable="true"]') || latest?.contains(e)) return 0;
    const r = e.getBoundingClientRect();
    return r.bottom >= 0 && r.top < innerHeight ? 1 : 2;
  };
  available.sort((a, b) => priority(a) - priority(b));
  const nodes = available.slice(0, 300);
  const context = e => {
    let p = e.closest('tr,[role="row"],.el-card,.ant-card') || e.parentElement;
    for (let i = 0; p && i < 5; i++, p = p.parentElement) { if (p.innerText?.trim()) return p.innerText.trim().slice(0, 700); }
    return '';
  };
  const metadata = nodes.map(e => ({ tag: e.tagName.toLowerCase(), type: e.type || '',
    label: (e.getAttribute('aria-label') || e.getAttribute('title') || e.placeholder || e.innerText || e.getAttribute('alt') || e.name || '').trim().slice(0, 400),
    context: context(e),
    disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true',
    accept: e.accept || '', multiple: !!e.multiple,
    files: e.type === 'file' ? [...e.files].map(f => ({ name: f.name, size: f.size, type: f.type })) : undefined,
    value: e.matches('input:not([type="file"]),textarea,select') ? String(e.value).slice(0, 2000) : undefined,
  }));
  const text = (scope.innerText || '').slice(0, 60000);
  const assistantText = latest?.innerText || '';
  const assistantHtml = latest?.innerHTML || '';
  const payload = { url: location.href, title: document.title, text, truncated: (scope.innerText || '').length > text.length,
    controlsTruncated: available.length > nodes.length, scope: dialogs.length ? 'dialog' : 'page', metadata,
    latestAssistant: latest ? { text: assistantText.slice(0, 200000), truncated: assistantText.length > 200000,
      codeBlocks: [...latest.querySelectorAll('pre')].map(e => e.innerText).slice(0, 30),
      images: [...latest.querySelectorAll('img')].map(e => ({ alt: e.alt, loaded: e.complete && e.naturalWidth > 0, width: e.naturalWidth, height: e.naturalHeight })),
      streaming: !!document.querySelector('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止生成"]') || /data-is-streaming="true"/.test(assistantHtml) } : null };
  return { nodes, payload: JSON.stringify(payload) };
}

function createPageBridge() {
  const snapshots = new Map(), attached = new WeakSet();
  async function command(contents, method, params = {}) {
    if (contents.isDestroyed()) throw new Error('网页已关闭');
    if (!contents.debugger.isAttached()) { contents.debugger.attach('1.3'); attached.add(contents); }
    else if (!attached.has(contents)) throw new Error('网页正在由另一个调试会话控制，请先关闭开发者工具');
    return contents.debugger.sendCommand(method, params);
  }
  async function read(contents, binding, options = {}) {
    const group = `creator-${randomUUID()}`;
    try {
      const root = await command(contents, 'DOM.getDocument', { depth: 0 });
      const evaluated = await command(contents, 'Runtime.evaluate', { expression: `(${snapshotInPage.toString()})()`, objectGroup: group });
      if (evaluated.exceptionDetails) throw new Error('网页内容读取失败');
      const props = await command(contents, 'Runtime.getProperties', { objectId: evaluated.result.objectId, ownProperties: true });
      const payload = JSON.parse(props.result.find(p => p.name === 'payload').value.value);
      const arrayId = props.result.find(p => p.name === 'nodes').value.objectId;
      const entries = await command(contents, 'Runtime.getProperties', { objectId: arrayId, ownProperties: true });
      const refs = new Map();
      const id = randomUUID();
      const controls = await Promise.all(entries.result.filter(p => /^\d+$/.test(p.name)).map(async prop => {
        const { node } = await command(contents, 'DOM.describeNode', { objectId: prop.value.objectId });
        const ref = `e${prop.name}`;
        refs.set(ref, node.backendNodeId);
        return { ref, ...payload.metadata[Number(prop.name)] };
      }));
      delete payload.metadata;
      snapshots.set(contents.id, { id, url: payload.url, documentId: root.root.backendNodeId, binding, refs, controls, createdAt: Date.now() });
      if (options.compact) {
        payload.text = payload.text.slice(0, options.maxText || 1200);
        payload.latestAssistant = payload.latestAssistant ? { length: payload.latestAssistant.text.length, streaming: payload.latestAssistant.streaming, truncated: payload.latestAssistant.truncated } : null;
        return { snapshotId: id, ...payload, compact: true, controls: controls.map(({context,label,...c})=>({...c,label:label.slice(0,100)})) };
      }
      return { snapshotId: id, ...payload, controls };
    } finally { await command(contents, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}); }
  }
  async function target(contents, { snapshotId, ref, projectId, expectedUrl }) {
    const snap = snapshots.get(contents.id);
    if (!snap || snap.id !== snapshotId || Date.now() - snap.createdAt > 300000) throw new Error('网页快照已过期，请重新读取');
    if (snap.binding.projectId !== projectId || snap.url !== expectedUrl || contents.getURL() !== expectedUrl) throw new Error('项目或网页地址已变化，请重新绑定');
    const root = await command(contents, 'DOM.getDocument', { depth: 0 });
    if (root.root.backendNodeId !== snap.documentId) throw new Error('网页已刷新，请重新读取');
    if (!snap.refs.has(ref)) throw new Error('网页控件不存在');
    const { object } = await command(contents, 'DOM.resolveNode', { backendNodeId: snap.refs.get(ref) });
    return { snap, objectId: object.objectId, backendNodeId: snap.refs.get(ref), metadata: snap.controls.find(c => c.ref === ref) };
  }
  async function call(contents, objectId, functionDeclaration, args = []) {
    const out = await command(contents, 'Runtime.callFunctionOn', { objectId, functionDeclaration,
      arguments: args.map(value => ({ value })), returnByValue: true, userGesture: true, awaitPromise: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || '网页操作失败');
    return out.result.value;
  }
  async function act(contents, request, guard = () => {}) {
    const t = await target(contents, request);
    try {
      guard();
      const result = await call(contents, t.objectId, function (action, value) {
        if (!this.isConnected || !this.getClientRects().length || this.disabled || this.getAttribute('aria-disabled') === 'true') throw new Error('控件已失效或不可用');
        if (action === 'click') { this.click(); return { status: 'clicked', label: this.innerText?.slice(0, 300) || this.getAttribute('aria-label') || '' }; }
        if (action !== 'fill') throw new Error('不支持的动作');
        if (this.matches('textarea,input:not([type="file"]):not([type="password"]):not([type="hidden"])')) {
          const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(this, value);
        } else if (this.isContentEditable) { this.focus(); this.textContent = value; }
        else throw new Error('目标不是文本输入框');
        this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return { status: 'filled', value: this.value ?? this.innerText };
      }.toString(), [request.action, request.text || '']);
      snapshots.delete(contents.id);
      return result;
    } finally { await command(contents, 'Runtime.releaseObject', { objectId: t.objectId }).catch(() => {}); }
  }
  async function upload(contents, request, files, guard = () => {}) {
    const t = await target(contents, request);
    try {
      const before = await call(contents, t.objectId, function () {
        if (!this.isConnected || this.type !== 'file' || this.disabled) throw new Error('不是可用的文件上传控件');
        return { multiple: this.multiple, existing: this.files.length };
      }.toString());
      if (!before.multiple && files.length > 1) throw new Error('此上传框只支持一个文件');
      if (before.existing) throw new Error('此上传框已有文件，请使用空的上传框');
      guard();
      await command(contents, 'DOM.setFileInputFiles', { backendNodeId: t.backendNodeId, files });
      const selected = await call(contents, t.objectId, function () {
        return [...this.files].map(f => ({ name: f.name, size: f.size, type: f.type }));
      }.toString());
      snapshots.delete(contents.id);
      // Some sites clear their input immediately after starting upload. Never infer server success here.
      return { status: 'files_delivered', files: selected, requestedCount: files.length, serverConfirmed: false,
        next: '重新读取网页，核实上传预览、场景入库与镜头绑定；文件已送入控件不等于平台绑定成功。' };
    } finally { await command(contents, 'Runtime.releaseObject', { objectId: t.objectId }).catch(() => {}); }
  }
  async function editorCall(contents, mode, args) {
    const out = await command(contents, 'Runtime.evaluate', { expression: `(${editorOperation.toString()})(${JSON.stringify(mode)},${JSON.stringify(args)})`, returnByValue:true, userGesture:true });
    if(out.exceptionDetails)throw Error(out.exceptionDetails.exception?.description || '正文操作失败');
    return out.result.value;
  }
  const digest = text => createHash('sha256').update(text).digest('hex');
  async function editorRead(contents, request) {
    const data = await editorCall(contents, 'read', {...request,includeText:true});
    const result = {...data, revision:digest(data.text)};
    if(!request.includeText)delete result.text;
    return result;
  }
  async function bindInline(contents, request, guard) {
    const started=Date.now();guard();
    let plan=await editorCall(contents,'plan',request);
    if(digest(plan.text)!==request.revision)throw Error('正文已变化，请重新读取后绑定');
    const original=plan.text; const results=[];
    for(const item of plan.items) {
      guard();
      const current=await editorCall(contents,'locate',{...request,item});
      if(current.status==='already_bound'){results.push(current);continue;}
      await command(contents,'Input.dispatchKeyEvent',{type:'keyDown',key:'@',code:'Digit2',text:'@',windowsVirtualKeyCode:50});
      await command(contents,'Input.dispatchKeyEvent',{type:'keyUp',key:'@',code:'Digit2',windowsVirtualKeyCode:50});
      let choice;
      for(let i=0;i<20;i++) {
        guard();choice=await editorCall(contents,'choose',{asset:item.asset});
        if(choice.found)break;
        await new Promise(r=>setTimeout(r,50));
      }
      if(!choice.found)throw Error('未找到唯一资产候选，已停止且未生成视频：'+JSON.stringify({asset:item.asset,...choice}));
      let verified;
      for(let i=0;i<20;i++) {verified=await editorCall(contents,'plan',request);if(verified.items.find(x=>x.anchor===item.anchor).status==='already_bound')break;await new Promise(r=>setTimeout(r,30));}
      if(verified.items.find(x=>x.anchor===item.anchor).status!=='already_bound')throw Error('资产标签插入后读回失败');
      results.push({anchor:item.anchor,asset:item.asset,status:'bound'});
    }
    const after=await editorRead(contents,{includeText:true});
    // Verify insertion did not rewrite surrounding prose, using actual inline offsets.
    let stripped=after.text;
    for(const item of [...results].reverse())if(item.status==='bound') {
      const at=stripped.indexOf(item.anchor,request.section ? stripped.indexOf(request.section) : 0)+item.anchor.length;
      const tail=stripped.slice(at);const pattern=new RegExp('^[\\s\\u200b]*'+item.asset.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'[\\u200b]*');
      const m=tail.match(pattern);if(!m)throw Error('标签位置验证失败');stripped=stripped.slice(0,at)+tail.slice(m[0].length);
    }
    if(stripped.replace(/\s/g,'')!==original.replace(/\s/g,''))throw Error('正文除引用之外发生变化，请检查草稿');
    snapshots.delete(contents.id);
    return {status:'draft_verified',submitted:false,elapsedMs:Date.now()-started,revision:after.revision,items:results,tags:after.tags};
  }
  return { read, act, upload, editorRead, bindInline };
}
module.exports = { createPageBridge };
