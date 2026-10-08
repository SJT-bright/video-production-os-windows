'use strict';

const SOURCE_FILES = Object.freeze([
  'app.js',
  'creator-assets.css',
  'creator-assets.html',
  'creator-assets.js',
  'creator-fixture.html',
  'creator-fixture.js',
  'creator.css',
  'creator.html',
  'creator.js',
  'creator-automation-ui.js',
  'creative-assets.cjs',
  'creative-projects.cjs',
  'drag-tray.css',
  'drag-tray.html',
  'drag-tray.js',
  'float-video.css',
  'float-video.html',
  'float-video.js',
  'editor-exports.cjs',
  'media-source-watch.cjs',
  'index.html',
  'package.json',
  'production-store.cjs',
  'script-breakdown-store.cjs',
  'server.js',
  'style.css',
  'tab-menu.css',
  'tab-menu.html',
  'tab-menu.js',
]);

const SOURCE_DIRS = Object.freeze(['assets', 'electron', 'vendor']);
// Every change to the verification semantics must invalidate old package manifests.
// Version 4 adds the creative-project registry to the packaged runtime contract.
// Version 5 adds the single-video float window renderer (float-video.html/css/js).
// Version 6 adds the tab context menu window renderer (tab-menu.html/css/js);
// electron/tab-menu-preload.cjs is packaged via SOURCE_DIRS.
const BUILD_SCHEMA_VERSION = 6;

module.exports = { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION };
