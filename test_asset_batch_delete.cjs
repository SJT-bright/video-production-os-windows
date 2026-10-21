'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAssetBatchDelete, MAX_BATCH_DELETE } = require('./electron/asset-batch-delete.cjs');

// Only real temporary files are renamed to a temporary recovery directory.
// This regression never loads server.js, Electron or the formal library.
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-batch-delete-')));
const receipts = [];
let sequence = 0;
function fixture() {
  const testRoot = path.join(root, `case-${++sequence}`);
  const libraryRoot = path.join(testRoot, 'library'), recoveryRoot = path.join(testRoot, 'recoverable');
  fs.mkdirSync(libraryRoot, { recursive: true }); fs.mkdirSync(recoveryRoot);
  const makeProject = (id, folder) => ({ id, folder, name: folder, available: true,
    categories: [{ id: 'browser-downloads', path: `${folder}/浏览器下载` }] });
  const a = makeProject('project-a', '剧本A'), b = makeProject('project-b', '剧本B');
  for (const project of [a, b]) {
    fs.mkdirSync(path.join(libraryRoot, project.folder));
    for (const directory of ['人物资产', '生成视频', '浏览器下载']) fs.mkdirSync(path.join(libraryRoot, project.folder, directory));
  }
  let active = a, epoch = 0, protectedPaths = [], failPath = '', trashHook = null, alive = true, currentTime = 0;
  const deleted = [], broadcasts = [], closed = [], warnings = [], confirmations = [];
  const absolute = relative => path.join(libraryRoot, ...relative.split('/'));
  const write = (relative, content = `bytes:${relative}`) => {
    const filename = absolute(relative); fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content); return filename;
  };
  const manager = createAssetBatchDelete({
    libraryRoot, getActiveProject: () => active, getProjectEpoch: () => epoch,
    now: () => currentTime,
    getProtectedPaths: () => protectedPaths,
    trash: async filename => {
      if (filename === failPath) throw new Error('fixture system Trash failure');
      const relative = path.relative(libraryRoot, filename).split(path.sep).join('/');
      fs.renameSync(filename, path.join(recoveryRoot, String(deleted.length)));
      deleted.push(relative); if (trashHook) await trashHook(relative);
    },
    onDeleted: item => closed.push(item.path), broadcast: payload => broadcasts.push(payload), onWarning: error => warnings.push(error.message),
  });
  const invoke = (paths, confirm = () => true, projectId = a.id, options = {}) => manager.deleteItems({ projectId, paths }, {
    isAlive: options.isAlive || (() => alive),
    confirm: info => { confirmations.push(info); return confirm(info); },
  });
  return { libraryRoot, recoveryRoot, absolute, write, a, b, invoke, deleted, broadcasts, closed, warnings, confirmations,
    setActive: (project, bumpEpoch = true) => { active = project; if (bumpEpoch) epoch++; }, setProtected: paths => { protectedPaths = paths; },
    setTime: time => { currentTime = time; },
    fail: relative => { failPath = absolute(relative); }, afterTrash: callback => { trashHook = callback; }, close: () => { alive = false; } };
}
const record = (name, result = {}) => receipts.push({ name, ...result });

async function main() {
  {
    const f = fixture(), image = '剧本A/人物资产/a.png', audio = '剧本A/人物资产/b.wav', video = '剧本A/生成视频/c.mp4';
    const files = [image, audio, video]; for (const relative of files) f.write(relative);
    const result = await f.invoke([image, image, audio.replaceAll('/', '\\'), video]);
    assert.deepEqual(result, { projectId: f.a.id, requested: 3, cancelled: false, deleted: files, failed: [] });
    assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].count, 3);
    assert.deepEqual(f.closed, files); assert.equal(f.broadcasts.length, 1);
    assert.deepEqual(f.broadcasts[0], { projectId: f.a.id, deleted: files, batchDelete: true });
    for (const relative of files) assert.equal(fs.existsSync(f.absolute(relative)), false);
    assert.equal(fs.readdirSync(f.recoveryRoot).length, 3); record('dedupe-one-confirm-one-broadcast-recoverable-files', result);
  }
  {
    const f = fixture(), file = '剧本A/人物资产/cancel.png'; f.write(file);
    const result = await f.invoke([file], () => false);
    assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, []);
    assert.equal(fs.existsSync(f.absolute(file)), true); assert.equal(f.broadcasts.length, 0);
    const approved = await f.invoke([file]); assert.deepEqual(approved.deleted, [file]); record('cancel-retains-file-releases-lock');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/a.png'; f.write(file);
    await assert.rejects(f.invoke(Array(MAX_BATCH_DELETE + 1).fill(file)), /上限/);
    await assert.rejects(f.invoke([file], () => true, f.b.id), /剧本已切换/);
    await assert.rejects(f.invoke([]), /请选择/);
    await assert.rejects(f.invoke([null]), /请选择/);
    assert.equal(f.confirmations.length, 0); assert.equal(fs.existsSync(f.absolute(file)), true); record('invalid-request-and-oversize-fail-closed');
  }
  {
    const f = fixture(), allowed = '剧本A/人物资产/allowed.png', other = '剧本B/人物资产/other.png', download = '剧本A/浏览器下载/doc.pdf';
    for (const relative of [allowed, other, download]) f.write(relative);
    const outside = path.join(root, 'outside.png'); fs.writeFileSync(outside, 'do not touch');
    fs.symlinkSync(outside, f.absolute('剧本A/人物资产/link.png'));
    fs.symlinkSync(path.dirname(outside), f.absolute('剧本A/人物资产/link-directory'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await f.invoke([allowed, other, download, '剧本A/人物资产', '剧本A/人物资产/link.png',
      '剧本A/人物资产/link-directory/outside.png', 'videoOS-generated://fake', '剧本A/../剧本B/人物资产/other.png']);
    assert.deepEqual(result.deleted, [allowed]); assert.equal(result.failed.length, 7); assert.equal(f.confirmations[0].count, 1);
    for (const relative of [other, download]) assert.equal(fs.existsSync(f.absolute(relative)), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not touch'); record('cross-project-directory-virtual-download-symlinks-rejected', result);
  }
  {
    const f = fixture(), file = '剧本A/生成视频/protected.mp4'; f.write(file); f.setProtected([f.absolute(file)]);
    const result = await f.invoke([file]); assert.equal(result.deleted.length, 0); assert.match(result.failed[0].error, /下载/);
    assert.equal(f.confirmations.length, 0); f.setProtected([]);
    const later = await f.invoke([file], () => { f.setProtected([f.absolute(file)]); return true; });
    assert.equal(later.deleted.length, 0); assert.match(later.failed[0].error, /下载/); assert.equal(fs.existsSync(f.absolute(file)), true);
    record('download-reservation-rechecked-after-confirmation');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/replaced.png'; f.write(file, 'original');
    const result = await f.invoke([file], () => {
      fs.renameSync(f.absolute(file), path.join(f.recoveryRoot, 'original')); f.write(file, 'replacement'); return true;
    });
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /已变更/);
    assert.equal(fs.readFileSync(f.absolute(file), 'utf8'), 'replacement'); assert.equal(fs.readFileSync(path.join(f.recoveryRoot, 'original'), 'utf8'), 'original');
    record('replacement-file-kept-intact');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/modified.png'; f.write(file, 'original');
    const result = await f.invoke([file], () => { f.write(file, 'edited during confirmation'); return true; });
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /已变更/);
    assert.equal(fs.readFileSync(f.absolute(file), 'utf8'), 'edited during confirmation'); record('modified-file-kept-intact');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/ancestor.png'; f.write(file);
    const result = await f.invoke([file], () => {
      const folder = f.absolute('剧本A/人物资产'), previous = f.absolute('剧本A/old-characters');
      fs.renameSync(folder, previous); fs.mkdirSync(folder); fs.renameSync(path.join(previous, 'ancestor.png'), f.absolute(file)); return true;
    });
    assert.deepEqual(result.deleted, []); assert.match(result.failed[0].error, /已变更/); assert.equal(fs.existsSync(f.absolute(file)), true);
    record('replaced-directory-with-same-file-inode-rejected');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/switched.png'; f.write(file);
    const result = await f.invoke([file], () => { f.setActive(f.b); return true; });
    assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, []); assert.equal(result.failed.length, 1);
    assert.equal(fs.existsSync(f.absolute(file)), true); record('project-switch-during-confirmation-stops-batch');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/aba.png'; f.write(file);
    const result = await f.invoke([file], () => { f.setActive(f.b); f.setActive(f.a); return true; });
    assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, []); assert.equal(fs.existsSync(f.absolute(file)), true);
    record('project-switch-away-and-back-cancels-old-consent');
  }
  {
    const f = fixture(), files = ['剧本A/人物资产/first.png', '剧本A/人物资产/second.png', '剧本A/人物资产/third.png'];
    for (const relative of files) f.write(relative); f.afterTrash(() => f.setActive(f.b));
    const result = await f.invoke(files);
    assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, [files[0]]); assert.equal(result.failed.length, 2);
    for (const relative of files.slice(1)) assert.equal(fs.existsSync(f.absolute(relative)), true);
    assert.equal(f.broadcasts.length, 1); record('project-switch-after-start-keeps-remaining-files', result);
  }
  {
    const f = fixture(), files = ['剧本A/人物资产/one.png', '剧本A/人物资产/fails.png', '剧本A/人物资产/three.png'];
    for (const relative of files) f.write(relative); f.fail(files[1]);
    const result = await f.invoke(files);
    assert.deepEqual(result.deleted, [files[0], files[2]]); assert.equal(result.failed.length, 1);
    assert.equal(fs.readFileSync(f.absolute(files[1]), 'utf8'), `bytes:${files[1]}`); assert.equal(f.broadcasts.length, 1);
    record('partial-os-failure-preserves-original-and-reports-successes', result);
  }
  {
    const f = fixture(), file = '剧本A/人物资产/concurrent.png'; f.write(file);
    let finish; const first = f.invoke([file], () => new Promise(resolve => { finish = resolve; }));
    await assert.rejects(f.invoke([file]), /已有批量删除/);
    assert.equal(f.confirmations.length, 1); finish(true);
    assert.deepEqual((await first).deleted, [file]); assert.equal(f.broadcasts.length, 1); record('concurrent-submission-denied-before-second-confirmation');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/window.png'; f.write(file);
    const result = await f.invoke([file], () => { f.close(); return true; });
    assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, []); assert.equal(fs.existsSync(f.absolute(file)), true);
    record('closed-origin-window-cancels-batch');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/dialog-error.png'; f.write(file);
    await assert.rejects(f.invoke([file], () => { throw new Error('fixture dialog failure'); }), /dialog failure/);
    assert.equal(fs.existsSync(f.absolute(file)), true); assert.deepEqual((await f.invoke([file])).deleted, [file]);
    record('confirmation-error-releases-lock');
  }
  {
    const f = fixture(), file = '剧本A/人物资产/strict-consent.png'; f.write(file);
    const malformed = [undefined, null, false, 1, 'true', {}, [], { approved: 1 }, { approved: 'true' },
      { approved: false, skipConfirmationForFiveMinutes: true }];
    for (const answer of malformed) {
      const result = await f.invoke([file], () => answer);
      assert.equal(result.cancelled, true); assert.deepEqual(result.deleted, []);
      assert.equal(fs.existsSync(f.absolute(file)), true);
    }
    assert.equal(f.confirmations.length, malformed.length);
    assert.deepEqual((await f.invoke([file], () => ({ approved: true }))).deleted, [file]);
    record('strict-boolean-or-object-approval-rejects-malformed-consent', { denied: malformed.length });
  }
  {
    const f = fixture(), files = ['剧本A/人物资产/cancel-checked.png', '剧本A/人物资产/after-cancel.png'];
    for (const relative of files) f.write(relative);
    const cancelled = await f.invoke([files[0]], () => ({ approved: false, skipConfirmationForFiveMinutes: true }));
    assert.equal(cancelled.cancelled, true); assert.equal(fs.existsSync(f.absolute(files[0])), true);
    await f.invoke([files[1]], () => ({ approved: true, skipConfirmationForFiveMinutes: false }));
    await f.invoke([files[0]], () => true);
    assert.equal(f.confirmations.length, 3); record('cancel-checked-does-not-arm-five-minute-skip');
  }
  {
    const f = fixture(), files = ['grant', 'inside', 'boundary', 'unchecked'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    f.setTime(12345);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setTime(12345 + 299999);
    await f.invoke([files[1]], () => { throw new Error('must skip within grant'); });
    assert.equal(f.confirmations.length, 1);
    f.setTime(12345 + 300000);
    await f.invoke([files[2]], () => ({ approved: true, skipConfirmationForFiveMinutes: 'true' }));
    await f.invoke([files[3]], () => true);
    assert.equal(f.confirmations.length, 3);
    record('five-minute-exact-boundary-skip-never-renews-nonboolean-checkbox-ignored');
  }
  {
    const f = fixture(), files = ['first', 'after-aba'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setActive(f.b); f.setActive(f.a);
    await f.invoke([files[1]], () => true);
    assert.equal(f.confirmations.length, 2); record('five-minute-grant-invalid-after-project-away-and-back');
  }
  {
    const f = fixture(), files = ['剧本A/人物资产/first.png', '剧本B/人物资产/other.png', '剧本A/人物资产/back.png'];
    for (const relative of files) f.write(relative);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    // Even an accidental reused epoch cannot carry consent into another folder.
    f.setActive({ ...f.b, id: f.a.id }, false);
    await f.invoke([files[1]], () => true);
    f.setActive(f.a, false);
    await f.invoke([files[2]], () => true);
    assert.equal(f.confirmations.length, 3); record('five-minute-grant-is-folder-scoped-and-not-revived');
  }
  {
    const f = fixture(), files = ['剧本A/人物资产/first.png', '剧本B/人物资产/other.png'];
    for (const relative of files) f.write(relative);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setActive(f.b, false);
    await f.invoke([files[1]], () => true, f.b.id);
    assert.equal(f.confirmations.length, 2); record('five-minute-grant-is-project-id-scoped');
  }
  {
    const f = fixture(), files = ['first', 'after-origin-closed'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.close();
    await f.invoke([files[1]], () => true, f.a.id, { isAlive: () => true });
    assert.equal(f.confirmations.length, 2); record('five-minute-grant-revoked-when-approving-window-closes');
  }
  {
    const f = fixture(), files = ['switched', 'after-switch'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    const first = await f.invoke([files[0]], () => {
      f.setActive(f.b); f.setActive(f.a);
      return { approved: true, skipConfirmationForFiveMinutes: true };
    });
    assert.equal(first.cancelled, true); assert.deepEqual(first.deleted, []);
    await f.invoke([files[1]], () => true);
    assert.equal(f.confirmations.length, 2); record('checked-consent-after-project-switch-cannot-arm-skip');
  }
  {
    const f = fixture(), files = ['closed', 'after-close'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    const first = await f.invoke([files[0]], () => {
      f.close(); return { approved: true, skipConfirmationForFiveMinutes: true };
    });
    assert.equal(first.cancelled, true); assert.deepEqual(first.deleted, []);
    await f.invoke([files[1]], () => true, f.a.id, { isAlive: () => true });
    assert.equal(f.confirmations.length, 2); record('checked-consent-after-window-close-cannot-arm-skip');
  }
  {
    const f = fixture(), grant = '剧本A/人物资产/grant.png', protectedFile = '剧本A/生成视频/download.mp4',
      other = '剧本B/人物资产/other.png', virtual = 'videoOS-generated://fake', download = '剧本A/浏览器下载/a.pdf';
    for (const relative of [grant, protectedFile, other, download]) f.write(relative);
    await f.invoke([grant], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setProtected([f.absolute(protectedFile)]);
    const invalid = await f.invoke([protectedFile, other, virtual, download, '剧本A/人物资产']);
    assert.deepEqual(invalid.deleted, []); assert.equal(invalid.failed.length, 5); assert.equal(f.confirmations.length, 1);
    for (const relative of [protectedFile, other, download]) assert.equal(fs.existsSync(f.absolute(relative)), true);
    f.setProtected([]);
    await f.invoke([protectedFile], () => { throw new Error('valid file should still use original grant'); });
    assert.equal(f.confirmations.length, 1); record('skip-does-not-bypass-file-project-download-or-directory-validation');
  }
  {
    const f = fixture(), files = ['grant', 'surface-a', 'surface-b'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    let releaseTrash;
    f.afterTrash(() => new Promise(resolve => { releaseTrash = resolve; }));
    const firstSurface = f.invoke([files[1]], () => { throw new Error('surface A should skip'); });
    await assert.rejects(f.invoke([files[2]], () => { throw new Error('surface B should not confirm while busy'); }), /已有批量删除/);
    assert.equal(f.confirmations.length, 1); releaseTrash(); await firstSurface;
    f.afterTrash(null);
    await f.invoke([files[2]], () => { throw new Error('surface B should share active grant'); }, f.a.id, { isAlive: () => true });
    assert.equal(f.confirmations.length, 1); assert.equal(f.deleted.length, 3);
    record('two-surfaces-share-skip-and-global-delete-lock');
  }
  {
    const f = fixture(), files = ['grant', 'backward', 'invalid-clock'].map(name => `剧本A/人物资产/${name}.png`);
    for (const relative of files) f.write(relative);
    f.setTime(100);
    await f.invoke([files[0]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setTime(99);
    await f.invoke([files[1]], () => ({ approved: true, skipConfirmationForFiveMinutes: true }));
    f.setTime(NaN);
    await f.invoke([files[2]], () => true);
    assert.equal(f.confirmations.length, 3); record('backward-or-invalid-clock-falls-back-to-confirmation');
  }
  {
    const f = fixture(), files = Array.from({ length: MAX_BATCH_DELETE }, (_, index) => `剧本A/人物资产/limit-${index}.png`);
    for (const relative of files) f.write(relative);
    const result = await f.invoke(files);
    assert.equal(result.requested, MAX_BATCH_DELETE); assert.equal(result.deleted.length, MAX_BATCH_DELETE);
    assert.equal(result.failed.length, 0); assert.equal(f.confirmations.length, 1); assert.equal(f.broadcasts.length, 1);
    record('exact-1000-limit-is-complete-not-truncated', { requested: result.requested, deleted: result.deleted.length });
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'temporary-files-and-injected-native-operations',
    formalAppTouched: false, realSystemTrashTested: false, checks: receipts }, null, 2));
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
