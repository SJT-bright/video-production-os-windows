'use strict';
// Fixed DOM adapter: no page-provided code, arbitrary selectors or generation actions.
function editorOperation(mode, args) {
  const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const dialogs = [...document.querySelectorAll('[role="dialog"],dialog[open],.el-dialog,.ant-modal')].filter(visible);
  const scope = dialogs.at(-1) || document.body;
  const editors = [...scope.querySelectorAll('[contenteditable="true"]')].filter(e => visible(e) && !e.parentElement.closest('[contenteditable="true"]'));
  if (editors.length !== 1) throw Error('必须有且只有一个可见正文编辑器');
  const editor = editors[0];
  const tags = [...editor.querySelectorAll('[contenteditable="false"],.mention,[data-type="mention"]')].filter(e => !e.parentElement.closest('[contenteditable="false"],.mention,[data-type="mention"]'));
  const plain = editor.textContent;
  const tagInfo = tags.map(e => { const r = document.createRange(); r.selectNodeContents(editor); r.setEndBefore(e); return { name: e.textContent.trim(), offset: r.toString().length, html: e.outerHTML.slice(0,800) }; });
  if (mode === 'read') return { text: args.includeText ? plain : undefined, length: plain.length,
    tags: tagInfo.map(({html,...t}) => ({...t, before: plain.slice(Math.max(0,t.offset-60),t.offset), after: plain.slice(t.offset+t.name.length,t.offset+t.name.length+100), markup: args.inspect ? html : undefined})),
    structure: args.inspect ? editor.outerHTML.slice(0,1800) : undefined };
  const locate = item => {
    if (!item.anchor || !item.asset) throw Error('定位文字与资产名不能为空');
    let start = 0, end = plain.length;
    if (args.section) { start = plain.indexOf(args.section); if(start < 0 || plain.indexOf(args.section,start+1)>=0) throw Error('章节定位不存在或不唯一'); }
    const positions = []; let at = start;
    while ((at = plain.indexOf(item.anchor, at)) >= 0 && at < end) { if(!tagInfo.some(t=>at>=t.offset && at<t.offset+t.name.length))positions.push(at); at += item.anchor.length; }
    if (positions.length !== 1) throw Error('定位文字不存在或不唯一：'+item.anchor);
    const offset = positions[0] + item.anchor.length;
    const existing = tagInfo.filter(t=>t.offset>=offset && !plain.slice(offset,t.offset).replace(/[\s\u200b]/g,''));
    if (existing.length) { if (existing[0].name !== item.asset) throw Error('该位置已引用其他资产：'+existing[0].name); return {anchor:item.anchor,asset:item.asset,status:'already_bound',offset}; }
    return {anchor:item.anchor,asset:item.asset,status:'pending',offset};
  };
  if (mode === 'plan') return { text: plain, items: args.items.map(locate), tags: tagInfo.map(({html,...t})=>t) };
  if (mode === 'locate') {
    const item = locate(args.item); if(item.status==='already_bound') return item;
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT); let node, count=0, found;
    while ((node=walker.nextNode())) { const len=node.textContent.length; if(item.offset <= count+len) { found={node,offset:item.offset-count};break; } count+=len; }
    if(!found || found.node.parentElement.closest('[contenteditable="false"],.mention,[data-type="mention"]')) throw Error('不能在现有标签内部设置光标');
    editor.focus(); const range=document.createRange();range.setStart(found.node,found.offset);range.collapse(true);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    if(selection.anchorNode!==found.node||selection.anchorOffset!==found.offset)throw Error('光标定位未生效');
    return item;
  }
  if (mode === 'choose') {
    const menus = [...document.querySelectorAll('[role="listbox"],.tippy-content,.mention-dropdown,.mention-list,.suggestion-list,.dropdown-menu-wrapper')].filter(visible);
    const candidates = [...new Set(menus.flatMap(menu => [...menu.querySelectorAll('[role="option"],li,button,.dropdown-menu-item,div')]))].filter(e => visible(e) && e.textContent.trim()===args.asset && ![...e.children].some(c=>c.textContent.trim()===args.asset));
    if (candidates.length!==1) return { found:false, count:candidates.length, menus:menus.map(m=>({class:m.className,text:m.innerText.slice(0,1500)})) };
    candidates[0].click();return {found:true};
  }
  throw Error('不支持的编辑操作');
}
module.exports={editorOperation};
