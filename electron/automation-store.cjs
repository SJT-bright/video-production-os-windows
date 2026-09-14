'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const STAGES = ['prompt', 'assets', 'references', 'submit', 'generating', 'archive', 'complete'];
const clone = value => JSON.parse(JSON.stringify(value));
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function required(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效`);
  return value.trim();
}

function createAutomationStore(directory) {
  const file = path.join(directory, 'workflows.json');
  let data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, runs: {}, operations: {} };
  if (data.version !== 1 || !data.runs || !data.operations) throw new Error('制作流程记录格式不兼容');
  // A process exit after an external effect is not evidence that the effect failed.
  for (const op of Object.values(data.operations)) if (op.status === 'running') op.status = 'uncertain';
  const save = next => { atomicWrite(file, next); data = next; };
  save(data);
  function get(id, projectId) {
    const run = data.runs[id];
    if (!run || run.projectId !== projectId) throw new Error('当前项目没有此制作流程');
    return clone(run);
  }
  return {
    list: projectId => Object.values(data.runs).filter(r => r.projectId === projectId).map(clone).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    get,
    create({ projectId, title, bindings }) {
      required(projectId, '项目'); required(title, '镜头名称', 200);
      const next = clone(data), id = randomUUID(), now = new Date().toISOString();
      next.runs[id] = { id, projectId, title, bindings, revision: 0, stage: 'prompt', status: 'ready',
        prompt: '', tailMode: 'unknown', newScene: null, assets: [], receipts: [], notes: '', createdAt: now, updatedAt: now };
      save(next); return get(id, projectId);
    },
    update({ id, projectId, revision, patch }) {
      const run = get(id, projectId);
      if (revision !== run.revision) throw new Error('流程已改变，请重新读取后更新');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('流程更新无效');
      const allowed = ['stage', 'status', 'prompt', 'tailMode', 'newScene', 'assets', 'receipts', 'notes'];
      if (Object.keys(patch).some(k => !allowed.includes(k))) throw new Error('不能修改流程身份或绑定');
      const merged = { ...run, ...clone(patch) };
      if (!STAGES.includes(merged.stage)) throw new Error('流程阶段无效');
      if (!['ready', 'waiting', 'blocked', 'submission_uncertain', 'done'].includes(merged.status)) throw new Error('流程状态无效');
      if (!['unknown', 'none', 'reference', 'first_frame'].includes(merged.tailMode)) throw new Error('尾帧用途无效');
      if (merged.newScene !== null && typeof merged.newScene !== 'boolean') throw new Error('新场景判断无效');
      if (typeof merged.prompt !== 'string' || merged.prompt.length > 200000 || typeof merged.notes !== 'string' || merged.notes.length > 20000) throw new Error('提示词或备注过长');
      if (!Array.isArray(merged.assets) || merged.assets.length > 100 || !Array.isArray(merged.receipts) || merged.receipts.length > 200) throw new Error('资产或回执数量无效');
      for (const asset of merged.assets) {
        required(asset.key, '资产编号', 100); required(asset.purpose, '资产用途');
        if (!['unverified', 'missing', 'ready', 'bound'].includes(asset.status)) throw new Error('资产状态无效');
        if (['ready', 'bound'].includes(asset.status)) required(asset.path, '资产路径');
        if (asset.status === 'bound') required(asset.binding, '网站绑定回执');
      }
      if (new Set(merged.assets.map(a => a.key)).size !== merged.assets.length) throw new Error('资产编号重复');
      for (const receipt of merged.receipts) { required(receipt.kind, '回执类型', 50); required(receipt.evidence, '回执证据', 10000); }
      const from = STAGES.indexOf(run.stage), to = STAGES.indexOf(merged.stage);
      if (to > from + 1 || to < from) throw new Error('请按顺序推进流程；返工请新建流程');
      if (to >= 1 && (!merged.prompt.trim() || merged.tailMode === 'unknown' || merged.newScene === null)) throw new Error('先保存完整提示词，并判断尾帧用途与新场景');
      if (to >= 2 && merged.assets.some(a => ['missing', 'unverified'].includes(a.status))) throw new Error('还有未补齐或未核对的资产');
      if (to >= 2 && ['reference', 'first_frame'].includes(merged.tailMode) && !merged.assets.some(a => a.role === 'tail' && ['ready', 'bound'].includes(a.status))) throw new Error('缺少实际成片尾帧资产');
      if (to >= 3 && merged.assets.some(a => a.status !== 'bound')) throw new Error('先核实全部参考图的网站绑定');
      if (to >= 4 && !merged.receipts.some(r => r.kind === 'submission')) throw new Error('缺少生成提交回执');
      if (to >= 5 && !merged.receipts.some(r => r.kind === 'generated')) throw new Error('缺少生成完成回执');
      if (to >= 6 && !merged.receipts.some(r => r.kind === 'archive')) throw new Error('缺少归档回执');
      if (merged.status === 'done' && merged.stage !== 'complete') throw new Error('尚未完成全部阶段');
      merged.revision++; merged.updatedAt = new Date().toISOString();
      const next = clone(data); next.runs[id] = merged; save(next); return clone(merged);
    },
    async once(key, request, action) {
      required(key, '操作编号', 200);
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      const old = data.operations[key];
      if (old) {
        if (old.hash !== hash) throw new Error('操作编号已用于不同请求');
        if (old.status === 'done') return { ...clone(old.result), replayed: true };
        throw new Error('此操作结果尚不确定，先检查网站结果；不要重复提交');
      }
      let next = clone(data); next.operations[key] = { hash, status: 'running', at: new Date().toISOString(), request }; save(next);
      try {
        const result = await action();
        next = clone(data); next.operations[key].status = 'done'; next.operations[key].result = result; save(next);
        return result;
      } catch (error) {
        next = clone(data); next.operations[key].status = 'uncertain'; next.operations[key].error = String(error.message).slice(0, 1000); save(next);
        throw error;
      }
    },
    operations: projectId => Object.entries(data.operations).filter(([, op]) => op.request.projectId === projectId).map(([id, op]) => ({ id, ...clone(op) })),
    resolveOperation({ id, projectId, evidence, outcome }) {
      const op = data.operations[id];
      if (!op || op.request.projectId !== projectId || op.status === 'running' || op.status === 'done') throw new Error('此操作不能补录');
      required(evidence, '网站核实证据', 10000);
      if (!['completed', 'not_applied'].includes(outcome)) throw new Error('核实结果无效');
      const next = clone(data);
      next.operations[id].status = 'done';
      next.operations[id].result = { status: outcome, evidence, reconciled: true };
      save(next); return clone(next.operations[id]);
    },
  };
}
module.exports = { createAutomationStore, atomicWrite, STAGES };
