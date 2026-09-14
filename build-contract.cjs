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
  'editor-exports.cjs',
  'media-source-watch.cjs',
  'index.html',
  'package.json',
  'production-store.cjs',
  'script-breakdown-store.cjs',
  'server.js',
  'style.css',
]);

const SOURCE_DIRS = Object.freeze(['assets', 'electron', 'vendor']);
// Every change to the verification semantics must invalidate old package manifests.
// Version 4 adds the creative-project registry to the packaged runtime contract.
const BUILD_SCHEMA_VERSION = 4;

module.exports = { SOURCE_FILES, SOURCE_DIRS, BUILD_SCHEMA_VERSION };
