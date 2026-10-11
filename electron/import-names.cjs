'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// All import paths share the same per-folder counter. Deleted numbers are not reused.
function nextSequentialImportName(directory, prefix, originalName) {
  const label = String(prefix || '').trim() || '资产';
  const extension = path.extname(originalName).toLowerCase();
  const counterPath = path.join(directory, '.import-sequences.json');
  let counters = {};
  if (fs.existsSync(counterPath)) {
    const stat = fs.lstatSync(counterPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('导入编号记录不可用');
    counters = JSON.parse(fs.readFileSync(counterPath, 'utf8'));
  }
  let max = Number.isSafeInteger(counters[label]) ? counters[label] : 0;
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-?(\\d+)\\.`, 'i');
  for (const entry of fs.readdirSync(directory)) {
    const match = entry.match(pattern);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  const next = max + 1;
  if (!Number.isSafeInteger(next)) throw new Error('导入编号超出上限');
  const temporary = `${counterPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...counters, [label]: next }), { flag: 'wx' });
    fs.renameSync(temporary, counterPath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return `${label}${String(next).padStart(3, '0')}${extension}`;
}
module.exports = { nextSequentialImportName };
