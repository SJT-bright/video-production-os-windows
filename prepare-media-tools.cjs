'use strict';

// FFmpeg 随应用发行；不依赖用户电脑预装 Homebrew 或额外命令。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

function binaryMatches(file, platform, arch) {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(512); fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (platform === 'darwin') {
      return buffer.readUInt32LE(0) === 0xfeedfacf && buffer.readUInt32LE(4) === (arch === 'arm64' ? 0x100000c : 0x1000007);
    }
    if (platform === 'win32') {
      const offset = buffer.readUInt32LE(0x3c);
      const pe = Buffer.alloc(6); fs.readSync(fd, pe, 0, 6, offset);
      return buffer.toString('ascii', 0, 2) === 'MZ' && pe.toString('ascii', 0, 4) === 'PE\0\0'
        && pe.readUInt16LE(4) === 0x8664;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

async function fetchFile(url, target, compressed = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`下载音频处理组件失败：HTTP ${response.status}`);
  const source = Readable.fromWeb(response.body);
  const output = fs.createWriteStream(target, { flags: 'wx' });
  if (compressed) await pipeline(source, zlib.createGunzip(), output);
  else await pipeline(source, output);
}

const PUBLIC_SOURCE_SHA256 = '8684f4b00f94b85461884c3719382f1261f0d9eb3d59640a1f4ac0873616f968';

function prepareRedistributableTools(platform, arch, root) {
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const directory = path.join(__dirname, 'vendor', 'media-tools', `${platform}-${arch}`);
  const input = root ? path.join(path.resolve(root), `${platform}-${arch}`) : directory;
  const binary = path.join(input, executable);
  const config = fs.readFileSync(path.join(input, 'config.h'), 'utf8');
  if (!/^#define CONFIG_NONFREE 0$/m.test(config) || !/^#define CONFIG_GPL 0$/m.test(config)
    || !/^#define CONFIG_VERSION3 0$/m.test(config) || !binaryMatches(binary, platform, arch)) {
    throw new Error('拒绝发布非 LGPL 或架构不匹配的音频组件');
  }
  const readme = fs.readFileSync(binary + '.README', 'utf8');
  if (!readme.includes(PUBLIC_SOURCE_SHA256)) throw new Error('音频组件缺少固定源码来源');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of [executable, executable + '.LICENSE', executable + '.README', 'FFmpeg-LICENSE.md',
    'config.h', 'configure-output.txt']) {
    const source = path.join(input, name), target = path.join(directory, name);
    if (path.resolve(source) !== path.resolve(target)) fs.copyFileSync(source, target);
  }
  // Compiler diagnostics can contain a builder's PATH and private directories.
  // Keep logs in the build workspace, not in the distributable application.
  fs.rmSync(path.join(directory, 'config.log'), { force: true });
  fs.chmodSync(path.join(directory, executable), 0o755);
  const manifest = { package: 'FFmpeg 6.1.1', release: 'ffmpeg-6.1.1-lgpl', platform, arch,
    redistributable: true, license: 'LGPL-2.1-or-later',
    source: 'https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz', sourceSha256: PUBLIC_SOURCE_SHA256,
    recipe: 'scripts/build-ffmpeg.sh',
    sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') };
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`MEDIA_TOOLS_REDISTRIBUTABLE_PASS ${platform}-${arch} ${manifest.sha256}`);
}

async function prepareMediaTools(platform, arch, options = {}) {
  if (arch === 'universal') {
    await prepareMediaTools(platform, 'arm64', options);
    await prepareMediaTools(platform, 'x64', options);
    return;
  }
  if (!(platform === 'darwin' && ['x64', 'arm64'].includes(arch)) && !(platform === 'win32' && arch === 'x64')) {
    throw new Error(`音频处理组件暂不支持 ${platform}-${arch}`);
  }
  if (process.env.VIDEO_OS_FFMPEG_BUILD_ROOT || options.redistributable || process.argv.includes('--redistributable')) {
    try { return prepareRedistributableTools(platform, arch, process.env.VIDEO_OS_FFMPEG_BUILD_ROOT); }
    catch (error) { throw new Error('公开构建需先运行 scripts/build-ffmpeg.sh 并设置 VIDEO_OS_FFMPEG_BUILD_ROOT：' + error.message); }
  }
  const pkg = require('ffmpeg-static/package.json');
  const release = pkg['ffmpeg-static']['binary-release-tag'];
  const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
  const root = path.join(__dirname, 'vendor', 'media-tools', `${platform}-${arch}`);
  const executable = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const target = path.join(root, executable);
  const manifestFile = path.join(root, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    const cached = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (cached.release === release && binaryMatches(target, platform, arch)
      && crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') === cached.sha256
      && fs.existsSync(`${target}.LICENSE`) && fs.existsSync(`${target}.README`)) return;
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-media-tools-'));
  try {
    const binary = path.join(stage, executable);
    const installed = require('ffmpeg-static');
    if (installed && binaryMatches(installed, platform, arch)
      && fs.existsSync(`${installed}.LICENSE`) && fs.existsSync(`${installed}.README`)) {
      for (const suffix of ['', '.LICENSE', '.README']) fs.copyFileSync(installed + suffix, binary + suffix);
    } else {
      await fetchFile(`${base}/ffmpeg-${platform}-${arch}.gz`, binary, true);
      await Promise.all([
        fetchFile(`${base}/${platform}-${arch}.LICENSE`, `${binary}.LICENSE`),
        fetchFile(`${base}/${platform}-${arch}.README`, `${binary}.README`),
      ]);
    }
    if (!binaryMatches(binary, platform, arch)) throw new Error('音频处理组件与目标系统或架构不匹配');
    fs.chmodSync(binary, 0o755);
    fs.mkdirSync(root, { recursive: true });
    for (const suffix of ['', '.LICENSE', '.README']) fs.copyFileSync(binary + suffix, target + suffix);
    fs.writeFileSync(manifestFile, JSON.stringify({ package: `ffmpeg-static@${pkg.version}`, release, platform, arch,
      source: `${base}/ffmpeg-${platform}-${arch}.gz`,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    }, null, 2) + '\n');
    console.log(`MEDIA_TOOLS_READY ${platform}-${arch} ${release}`);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (require.main === module) prepareMediaTools(process.argv[2] || process.platform, process.argv[3] || process.arch)
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareMediaTools, binaryMatches };
