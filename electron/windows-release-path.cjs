'use strict';

const path = require('path');

// Downloadable Windows builds never embed the build machine's workspace path.
// User data lives outside the extracted application so upgrades keep all assets.
function windowsReleasePaths({ platform, isPackaged, config, userData }) {
  if (platform !== 'win32' || !isPackaged || config?.dataLocation !== 'userData') return null;
  if (!path.isAbsolute(userData)) throw new Error('Windows 用户数据目录必须是绝对路径');
  const projectRoot = path.join(userData, 'workspace');
  return { projectRoot, dataDir: path.join(projectRoot, '视频制作OS', 'data') };
}

module.exports = { windowsReleasePaths };
