'use strict';

const SOURCE_FILES = Object.freeze([
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
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
  'asset-workflow.cjs',
  'float-video.css',
  'float-video.html',
  'float-video.js',
  'editor-exports.cjs',
  'media-source-watch.cjs',
  'index.html',
  'package.json',
  'production-store.cjs',
  'project-documents.cjs',
  'script-breakdown-store.cjs',
  'server.js',
  'style.css',
  'voice-clips.cjs',
  'tab-menu.css',
  'tab-menu.html',
  'tab-menu.js',
  'workspace-menu.css',
  'workspace-menu.html',
  'workspace-menu.js',
]);

const SOURCE_DIRS = Object.freeze(['assets', 'electron', 'vendor']);
// Every change to the verification semantics must invalidate old package manifests.
// Version 4 adds the creative-project registry to the packaged runtime contract.
// Version 5 adds the single-video float window renderer (float-video.html/css/js).
// Version 6 adds the tab context menu window renderer (tab-menu.html/css/js);
// electron/tab-menu-preload.cjs is packaged via SOURCE_DIRS.
// Version 7 removes the retired mini drag tray and its preload from runtime resources.
// Version 8 gives project/tab pickers their own native overlay without hiding the platform page.
// Version 9 includes bounded asynchronous project-document scanning.
// Version 10 preserves source and third-party notices in public application bundles.
const BUILD_SCHEMA_VERSION = 10;

module.exports = { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION };
