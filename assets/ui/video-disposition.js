(function (root, factory) {
  'use strict';
  const types = factory();
  if (typeof module === 'object' && module.exports) module.exports = types;
  else root.VideoDisposition = types;
})(globalThis, function () {
  'use strict';
  function disposition(item) {
    const parts = String(item?.folderPath || item?.relativePath || item?.displayPath || item?.path || '').replace(/\\/g, '/').split('/');
    const videoRoot = parts.indexOf('生成视频');
    if (videoRoot >= 0 && parts[videoRoot + 1] === '待处理') return 'processing';
    return 'editable';
  }
  return Object.freeze({ of: disposition, label: item => disposition(item) === 'processing' ? '待处理' : '可剪辑' });
});
