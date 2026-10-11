'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { resolveCreativeAsset, classifyCreativeAsset } = require('./creative-assets.cjs');
const { sanitizeFilename } = require('./electron/download-router.cjs');

const SAMPLE_RATE = 24000;
const MAX_SECONDS = 1800;
const SESSION_TTL = 30 * 60 * 1000;

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function findFFmpeg() {
  const executable = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [
    process.env.VIDEO_OS_FFMPEG,
    path.join(__dirname, 'vendor', 'media-tools', `${process.platform}-${process.arch}`, executable),
  ];
  try { candidates.push(require('ffmpeg-static')); } catch {}
  if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg');
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, executable));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  throw failure('缺少音频处理组件，请安装新版 App 后重试', 503);
}

function decodeAudio(source, target, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(findFFmpeg(), [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-i', source,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-t', String(MAX_SECONDS + 1), '-c:a', 'pcm_s16le', target,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const cancel = () => child.kill();
    const timer = setTimeout(() => { timedOut = true; cancel(); }, 120000);
    timer.unref();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
    child.once('error', error => { cleanup(); reject(failure(`音频处理组件无法启动：${error.message}`, 503)); });
    child.once('close', code => {
      cleanup();
      if (signal?.aborted) reject(failure('已取消提取', 499));
      else if (timedOut) reject(failure('提取超时，请选取较短的视频后重试', 408));
      else if (code === 0) resolve();
      else if (/matches no streams|does not contain any stream|no audio/i.test(stderr)) reject(failure('这个视频没有可提取的音轨', 422));
      else reject(failure('视频音轨无法读取，请换一个视频重试', 422));
    });
  });
}

function readWav(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw failure('提取音频格式无效', 422);
    let position = 12;
    let validFormat = false;
    while (position + 8 <= size) {
      const chunk = Buffer.alloc(8);
      fs.readSync(fd, chunk, 0, 8, position);
      const length = chunk.readUInt32LE(4);
      const id = chunk.toString('ascii', 0, 4);
      if (position + 8 + length > size) throw failure('提取音频尚未完成', 422);
      if (id === 'fmt ' && length >= 16) {
        const format = Buffer.alloc(16);
        fs.readSync(fd, format, 0, 16, position + 8);
        validFormat = format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 1
          && format.readUInt32LE(4) === SAMPLE_RATE && format.readUInt16LE(14) === 16;
      }
      if (id === 'data' && validFormat && length >= 2) {
        const frames = Math.floor(length / 2);
        return { offset: position + 8, frames, duration: frames / SAMPLE_RATE };
      }
      position += 8 + length + (length % 2);
    }
    throw failure('没有可读取的音频采样', 422);
  } finally { fs.closeSync(fd); }
}

function wavHeader(frames) {
  const dataBytes = frames * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(dataBytes + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function waveform(file, info) {
  const bins = Math.min(1000, info.frames);
  const peaks = new Float32Array(bins);
  let frame = 0;
  for await (const buffer of fs.createReadStream(file, { start: info.offset, end: info.offset + info.frames * 2 - 1, highWaterMark: 64 * 1024 })) {
    for (let offset = 0; offset + 1 < buffer.length; offset += 2, frame++) {
      const bin = Math.min(bins - 1, Math.floor(frame * bins / info.frames));
      peaks[bin] = Math.max(peaks[bin], Math.abs(buffer.readInt16LE(offset)) / 32768);
    }
  }
  return Array.from(peaks, value => Math.round(value * 10000) / 10000);
}

function createVoiceClipService({ assetRoot, projectStore, onSaved = () => {} }) {
  const sessions = new Map();
  let tempRoot = '';
  let pending = 0;
  let closed = false;
  const decoders = new Set();
  const cleanRoot = () => {
    if (closed && tempRoot && !pending && !sessions.size) fs.rmSync(tempRoot, { recursive: true, force: true });
  };
  const expire = token => {
    const session = sessions.get(token);
    if (!session) return;
    if (session.busy) { session.releaseRequested = true; return; }
    sessions.delete(token);
    fs.rmSync(session.directory, { recursive: true, force: true });
    cleanRoot();
  };
  const timer = setInterval(() => {
    for (const [token, session] of sessions) if (Date.now() - session.touched > SESSION_TTL) expire(token);
  }, 60000);
  timer.unref();

  function activeProject(id) {
    const project = projectStore.active();
    if (!project?.available || project.id !== id) throw failure('剧本已切换，请重新打开视频提取音频', 409);
    return project;
  }

  function sourceFile(project, relativePath) {
    if (typeof relativePath !== 'string' || !relativePath.startsWith(`${project.folder}/`)) throw failure('视频不属于当前剧本', 403);
    const entry = resolveCreativeAsset(assetRoot, relativePath, 'file');
    if (!entry || classifyCreativeAsset(entry.abs) !== 'video') throw failure('请选择本剧资产里的视频', 404);
    return entry;
  }

  function sessionFor(token, projectId) {
    activeProject(projectId);
    const session = sessions.get(String(token || ''));
    if (!session || session.projectId !== projectId) throw failure('试听已过期，请重新提取', 410);
    if (Date.now() - session.touched > SESSION_TTL) { expire(token); throw failure('试听已过期，请重新提取', 410); }
    session.touched = Date.now();
    return session;
  }

  return {
    async prepare({ projectId, sourcePath }, signal) {
      if (closed) throw failure('音频处理服务已关闭', 503);
      const project = activeProject(projectId);
      const source = sourceFile(project, sourcePath);
      if (sessions.size + pending >= 6) throw failure('试听窗口过多，请先关闭不用的音频截取窗口', 429);
      pending++;
      if (!tempRoot) tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-voice-clips-'));
      const directory = fs.mkdtempSync(path.join(tempRoot, 'preview-'));
      const file = path.join(directory, 'track.wav');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      decoders.add(controller);
      try {
        await decodeAudio(source.abs, file, controller.signal);
        activeProject(projectId);
        if (controller.signal.aborted) throw failure('已取消提取', 499);
        const info = readWav(file);
        if (info.duration > MAX_SECONDS) throw failure('这一版支持 30 分钟以内的视频，请先选取较短的视频', 422);
        if (info.duration < .02) throw failure('视频音轨太短，无法截取', 422);
        const peaks = await waveform(file, info);
        if (controller.signal.aborted) throw failure('已取消提取', 499);
        const token = crypto.randomBytes(24).toString('hex');
        sessions.set(token, { projectId, sourcePath, file, directory, info, touched: Date.now(), busy: false });
        return { token, duration: info.duration, sampleRate: SAMPLE_RATE, peaks, projectId,
          projectName: project.name, sourceName: path.basename(source.abs) };
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        decoders.delete(controller); pending--; cleanRoot();
      }
    },
    preview(token, projectId) { return sessionFor(token, projectId).file; },
    async save({ token, projectId, start, end, name, characterName = '', description = '' }) {
      const session = sessionFor(token, projectId);
      const project = activeProject(projectId);
      if (session.busy) throw failure('正在保存这段音频，请稍候', 409);
      // 保存时重新检查原视频，避免已删除或移出本剧的视频留下错误来源。
      sourceFile(project, session.sourcePath);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > session.info.duration + 1 / SAMPLE_RATE || end <= start) throw failure('截取起止时间无效', 400);
      const first = Math.round(start * SAMPLE_RATE);
      const last = Math.min(session.info.frames, Math.round(end * SAMPLE_RATE));
      const frames = last - first;
      if (frames < SAMPLE_RATE * .02) throw failure('截取片段太短，请调整起止时间', 400);
      const title = String(name || '').trim();
      const character = String(characterName || '').trim();
      const notes = String(description || '').trim();
      if (!title || title.length > 120 || character.length > 120 || notes.length > 2000) throw failure('请填写有效名称（最多 120 字）和音色描述（最多 2000 字）', 400);
      const filename = sanitizeFilename(title.replace(/\.wav$/i, '') + '.wav');
      const folder = projectStore.category(projectId, 'audio');
      if (!resolveCreativeAsset(assetRoot, folder.path, 'folder')) throw failure('当前剧本音频目录不可用', 404);
      let target;
      let handle;
      let createdTarget = false;
      session.busy = true;
      try {
        for (let index = 0; index < 10000; index++) {
          const parsed = path.parse(filename);
          target = path.join(folder.absolutePath, index ? `${parsed.name}-${index + 1}${parsed.ext}` : filename);
          try { handle = await fs.promises.open(target, 'wx'); createdTarget = true; break; }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        if (!handle) throw failure('同名音频过多，请换一个名称', 409);
        await handle.writeFile(wavHeader(frames));
        await handle.close(); handle = null;
        await pipeline(fs.createReadStream(session.file, { start: session.info.offset + first * 2, end: session.info.offset + last * 2 - 1 }), fs.createWriteStream(target, { flags: 'a' }));
        activeProject(projectId);
        const stat = fs.statSync(target);
        const clip = { id: crypto.randomUUID(), projectId, kind: 'voice', name: path.parse(path.basename(target)).name,
          filename: path.basename(target), path: `${folder.path}/${path.basename(target)}`, size: stat.size,
          characterName: character, description: notes, duration: frames / SAMPLE_RATE,
          sourcePath: session.sourcePath, sourceStart: first / SAMPLE_RATE, sourceEnd: last / SAMPLE_RATE,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await onSaved(clip);
        return clip;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (createdTarget) fs.rmSync(target, { force: true });
        throw error;
      } finally {
        session.busy = false; session.touched = Date.now();
        if (session.releaseRequested || closed) expire(token);
      }
    },
    relocateSources(oldPath, newPath, isFolder) {
      for (const session of sessions.values()) {
        if (session.sourcePath === oldPath || (isFolder && session.sourcePath.startsWith(`${oldPath}/`))) {
          session.sourcePath = newPath + session.sourcePath.slice(oldPath.length);
        }
      }
    },
    release(token, projectId) {
      const session = sessions.get(String(token || ''));
      if (session?.projectId === projectId) expire(token);
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const controller of decoders) controller.abort();
      for (const token of sessions.keys()) expire(token);
      cleanRoot();
    },
  };
}

module.exports = { createVoiceClipService, readWav, wavHeader, findFFmpeg, SAMPLE_RATE };
