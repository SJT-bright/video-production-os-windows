'use strict';
const assert = require('node:assert/strict');
const VideoDisposition = require('./assets/ui/video-disposition.js');

// 普通目录移动/改名不能把持久待处理状态变成可剪辑；指定分类动作可以覆盖旧路径。
assert.equal(VideoDisposition.of({ path: '本剧/第01集/镜头.mp4', videoDisposition: 'processing' }), 'processing');
assert.equal(VideoDisposition.of({ path: '本剧/生成视频/待处理/镜头.mp4', videoDisposition: 'editable' }), 'editable');
assert.equal(VideoDisposition.of({ path: '本剧/生成视频/待处理/旧素材.mp4' }), 'processing');
assert.equal(VideoDisposition.of({ path: '本剧/第01集/旧素材.mp4' }), 'editable');
assert.equal(VideoDisposition.role({ path: '本剧/交付/成片.mp4', assetRole: 'finals' }), 'finals');
assert.equal(VideoDisposition.role({ path: '本剧/成片/普通素材.mp4', assetRole: 'material' }), 'material');
assert.equal(VideoDisposition.role({ path: '本剧/成片/旧成片.mp4' }), 'finals');
assert.equal(VideoDisposition.label({ videoDisposition: 'processing' }), '待处理');
assert.equal(VideoDisposition.label({ videoDisposition: 'editable' }), '可剪辑');
console.log('VIDEO_DISPOSITION_PASS');
