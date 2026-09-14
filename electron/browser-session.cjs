'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { normalizeBrowserAddress } = require('./browser-address.cjs');

const BROWSER_SESSION_SCHEMA_VERSION = 1;
const MAX_TAB_NAME_LENGTH = 120;
const MODES = ['image', 'video'];

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMode(value) {
  if (!MODES.includes(value)) throw new Error('浏览器会话包含未知创作模式');
  return value;
}

function normalizeId(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`浏览器会话的${label}无效`);
  return value.trim();
}

function normalizeSnapshot(snapshot) {
  if (!isObject(snapshot) || snapshot.schemaVersion !== BROWSER_SESSION_SCHEMA_VERSION) {
    throw new Error('浏览器会话版本或格式无效');
  }
  if (!Array.isArray(snapshot.tabs)) throw new Error('浏览器会话标签必须是数组');
  const activeMode = normalizeMode(snapshot.activeMode);
  const ids = new Set();
  const tabs = [];
  for (const source of snapshot.tabs) {
    if (!isObject(source)) throw new Error('浏览器会话标签格式无效');
    const id = normalizeId(source.id, '标签 ID');
    const serviceId = normalizeId(source.serviceId, '平台 ID');
    const mode = normalizeMode(source.mode);
    if (typeof source.url !== 'string') throw new Error('浏览器会话网址无效');
    const url = normalizeBrowserAddress(source.url);
    if (ids.has(id)) continue;
    ids.add(id);
    tabs.push({
      id, serviceId, mode, url,
      customName: typeof source.customName === 'string'
        ? [...source.customName].slice(0, MAX_TAB_NAME_LENGTH).join('') : '',
    });
  }
  const lastModeTabs = {};
  const initializedModes = {};
  for (const mode of MODES) {
    const remembered = snapshot.lastModeTabs?.[mode];
    lastModeTabs[mode] = tabs.some(tab => tab.id === remembered && tab.mode === mode) ? remembered : null;
    // 空标签列表是有效会话；显式 true 必须保留，才能记住用户主动清空。
    initializedModes[mode] = snapshot.initializedModes?.[mode] === true;
  }
  return { schemaVersion: BROWSER_SESSION_SCHEMA_VERSION, tabs, activeMode, lastModeTabs, initializedModes };
}

function writeAtomically(filePath, snapshot) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor = null;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (temporaryCreated) {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
    throw error;
  }
}

function createBrowserSessionStore({ filePath, onWarning } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error('浏览器会话路径必须是绝对路径');
  }
  return {
    load() {
      try {
        return normalizeSnapshot(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
      } catch (error) {
        if (error.code !== 'ENOENT' && typeof onWarning === 'function') {
          try { onWarning(`浏览器会话无法读取，原文件已保留：${error.message}`); } catch {}
        }
        return null;
      }
    },
    save(snapshot) {
      const normalized = normalizeSnapshot(snapshot);
      writeAtomically(filePath, normalized);
      return normalized;
    },
  };
}

module.exports = { BROWSER_SESSION_SCHEMA_VERSION, MAX_TAB_NAME_LENGTH, createBrowserSessionStore };
