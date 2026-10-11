'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Pure numeric filenames, one counter per directory (independent of category names).
// Prefixes are read only to continue legacy numbering; existing files are never renamed.
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
  let max = 0;
  for (const value of Object.values(counters)) {
    if (Number.isSafeInteger(value) && value > max) max = value;
  }
  const pattern = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-?(\\d+)\\.`, 'i');
  for (const entry of fs.readdirSync(directory)) {
    const match = entry.match(/^(\d+)\./) || entry.match(pattern);
    if (match) max = Math.max(max, Number(match[1]) || 0);
  }
  const next = max + 1;
  if (!Number.isSafeInteger(next)) throw new Error('导入编号超出上限');
  const temporary = `${counterPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...counters, '.numeric': next }), { flag: 'wx' });
    fs.renameSync(temporary, counterPath);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return `${String(next).padStart(3, '0')}${extension}`;
}
module.exports = { nextSequentialImportName };
