'use strict';
// Every suite uses independent fixture roots. Report all failures from one
// platform run without weakening any assertion or publishing a partial pass.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const suites = ['test_browser_session.cjs', 'test_browser_retention.cjs', 'test_creator_sidebar_state.cjs',
  'test_creator_file_access.cjs', 'test_prompt_template_store.cjs', 'test_download_router.cjs',
  'test_download_episodes.cjs', 'test_download_review.cjs', 'test_editor_exports.cjs', 'test_asset_linkage.cjs',
  'test_creative_projects.cjs', 'test_build_manifest.cjs', 'test_project_documents.cjs', 'test_asset_workflow.cjs',
  'test_voice_clips.cjs', 'test_folder_management.cjs', 'test_media_import.cjs', 'test_media_sources.cjs', 'test_production_store.cjs'];
const checks = [['--check', 'project-documents.cjs'], ['--check', 'prepare-media-tools.cjs'], ...suites.map(file => [file])];
const failed = [];
for (const args of checks) {
  console.log(`SOURCE_SUITE_START ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 180000 });
  if (result.status !== 0 || result.error) {
    failed.push({ args, exit: result.status, error: result.error?.message || '' });
    console.error(`SOURCE_SUITE_FAILED ${args.join(' ')}`);
  }
}
console.log('SOURCE_SUITES_RESULT ' + JSON.stringify({ required: checks.length, failed }));
process.exitCode = failed.length ? 1 : 0;
