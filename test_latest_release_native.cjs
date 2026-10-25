'use strict';
// Run only the exact package made by this job, with disposable fixture data.
// Native layout evidence is not proof of physical dragging into third-party apps.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const version = require('./package.json').version;
const executable = process.platform === 'darwin'
  ? path.join(__dirname, 'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app/Contents/MacOS/VideoProductionOS')
  : process.platform === 'win32' ? path.join(__dirname, 'dist/视频制作OS-win32-x64/视频制作OS.exe') : null;
assert.ok(executable && fs.statSync(executable).isFile(), 'Native release package is required');
const evidence = path.join(__dirname, 'test-artifacts/latest-release-native');
assert.equal(fs.existsSync(evidence), false, 'Use a fresh native verification directory');
fs.mkdirSync(evidence, { recursive: true });
function run(file, extra) {
  const result = spawnSync(process.execPath, [file], { cwd: __dirname,
    env: { ...process.env, ...extra }, stdio: 'inherit', timeout: 300000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, file + ' must pass before publishing');
}
run('test_image_rename_native.cjs', { RENAME_TEST_EXECUTABLE: executable,
  RENAME_TEST_VERSION: version, RENAME_TEST_EVIDENCE: path.join(evidence, 'image-rename') });
const rename = JSON.parse(fs.readFileSync(path.join(evidence, 'image-rename/receipt.json')));
assert.equal(rename.status, 'passed');
for (const key of ['cancelWithoutWrite', 'collisionPreservesFileAndDialog',
  'imageRenameUpdatesFileAndUi', 'videoRenameUpdatesFileAndUi']) assert.equal(rename.checks[key], true, key);
run('test_split_direct_cdp.cjs', { SPLIT_TEST_EXECUTABLE: executable,
  SPLIT_TEST_VERSION: version, SPLIT_TEST_EVIDENCE: path.join(evidence, 'split-layout'), SPLIT_LAYOUT_ONLY: '1' });
const split = JSON.parse(fs.readFileSync(path.join(evidence, 'split-layout/receipt.json')));
assert.equal(split.status, 'layout-passed-drag-not-tested');
for (const key of ['realChooserAndTwoSecureNativeViews', 'ratioAndNonOverlappingBounds',
  'pairBackdropResizeCancelAndLateCapture', 'pushedAssetPanelDoesNotCropSecondPage',
  'frozenBackdropSurvivesResizeWithoutHiddenRecapture',
  'captureFailureHasOpaqueFallbackAndRestores', 'realSecondPageReplacementKeepsFirstPage',
  'sidebarCollapseReloadExpandKeepsNativePages', 'closePreservesBothDocumentsAndDrafts',
  'restartKeepsBothTabsAndCanSplitAgain']) assert.equal(split.checks[key], true, key);
assert.ok(split.processes.every(p => p.exited), 'All owned App processes must exit');
run('test_tab_wheel_native.cjs', { WHEEL_TEST_EXECUTABLE: executable,
  WHEEL_TEST_EVIDENCE: path.join(evidence, 'tab-wheel') });
run('test_download_delete_native.cjs', { DOWNLOAD_DELETE_EXECUTABLE: executable,
  DOWNLOAD_DELETE_EVIDENCE: path.join(evidence, 'download-delete') });
console.log('DESKTOP_LATEST_NATIVE_PASS version=' + version + ' platform=' + process.platform
  + ' imageRename=true splitLayout=true sidebar=true physicalOsDragTested=false');
