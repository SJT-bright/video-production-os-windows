(function (root, factory) {
  'use strict';
  const types = factory();
  if (typeof module === 'object' && module.exports) module.exports = types;
  else root.VideoDisposition = types;
})(globalThis, function () {
  'use strict';
  function disposition(item) {
    // 素材整理后的状态来自持久元数据；路径只兼容还没有状态的旧记录。
    if (item?.videoDisposition === 'processing' || item?.videoDisposition === 'editable') {
      return item.videoDisposition;
    }
    const parts = String(item?.folderPath || item?.relativePath || item?.displayPath || item?.path || '').replace(/\\/g, '/').split('/');
    const videoRoot = parts.indexOf('生成视频');
    if (videoRoot >= 0 && parts.slice(videoRoot + 1).includes('待处理')) return 'processing';
    return 'editable';
  }
  function role(item) {
    if (typeof item?.assetRole === 'string' && item.assetRole) return item.assetRole;
    const parts = String(item?.folderPath || item?.relativePath || item?.displayPath || item?.path || '').replace(/\\/g, '/').split('/');
    return parts.includes('成片') ? 'finals' : 'material';
  }
  return Object.freeze({
    of: disposition,
    role,
    label: item => disposition(item) === 'processing' ? '待处理' : '可剪辑',
  });
});
