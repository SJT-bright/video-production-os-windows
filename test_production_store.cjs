'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { ProductionStore, CURRENT_SCHEMA_VERSION } = require('./production-store.cjs');

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'video-os-production-'));
let store;

function expectError(work, code, message) {
  assert.throws(
    work,
    error => error && error.code === code,
    message || `应拒绝并返回 ${code}`,
  );
}

function createLegacyDatabase(dataDir, { version = 1, brokenForeignKey = false } = {}) {
  assert.ok(version === 1 || version === 2, '测试旧库只支持 v1/v2');
  fs.mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, 'production.sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE shots (
        id TEXT PRIMARY KEY,
        shot_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
        title TEXT NOT NULL,
        task TEXT NOT NULL DEFAULT '',
        episode TEXT NOT NULL DEFAULT '',
        scene TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned', 'generating', 'review', 'approved', 'blocked')),
        stage TEXT NOT NULL DEFAULT 'prompt',
        duration_sec INTEGER CHECK (duration_sec IS NULL OR (duration_sec >= 1 AND duration_sec <= 900)),
        tail_frame_status TEXT NOT NULL DEFAULT 'none'
          CHECK (tail_frame_status IN ('none', 'pending', 'confirmed')),
        continuity_from_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE creative_context (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
        service_id TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'video' CHECK (mode IN ('image', 'video')),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE asset_refs (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE COLLATE NOCASE,
        kind TEXT NOT NULL,
        internal_source TEXT NOT NULL DEFAULT 'generated',
        origin_type TEXT NOT NULL DEFAULT 'generated_output',
        confirmed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE shot_asset_uses (
        shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES asset_refs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('reference', 'first_frame', 'continuity_tail', 'audio', 'output')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (shot_id, asset_id, purpose)
      );
      CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        download_key TEXT NOT NULL UNIQUE,
        asset_id TEXT REFERENCES asset_refs(id) ON DELETE SET NULL,
        asset_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('image', 'video')),
        service_id TEXT NOT NULL DEFAULT '',
        service_label TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'platform',
        captured_shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
        context_revision INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'unassigned' CHECK (state IN ('unassigned', 'assigned', 'dismissed')),
        error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX inbox_state_updated_idx ON inbox_items(state, updated_at DESC);
      CREATE INDEX inbox_shot_updated_idx ON inbox_items(captured_shot_id, updated_at DESC);
      CREATE INDEX shot_status_updated_idx ON shots(status, updated_at DESC);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, '2026-08-26T00:00:00.000Z');
      INSERT INTO shots (id, shot_no, title, task, status, created_at, updated_at)
      VALUES ('legacy-shot', 'S01', '旧版镜头', '迁移前的唯一任务', 'planned', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z');
      INSERT INTO creative_context (singleton, active_shot_id, service_id, mode, revision, updated_at)
      VALUES (1, 'legacy-shot', 'updream', 'video', 3, '2026-08-26T00:00:00.000Z');
      INSERT INTO asset_refs (id, path, kind, created_at)
      VALUES ('legacy-asset', '素材库/旧镜头.mp4', 'video', '2026-08-26T00:00:00.000Z');
      INSERT INTO shot_asset_uses (shot_id, asset_id, purpose, created_at)
      VALUES ('legacy-shot', 'legacy-asset', 'output', '2026-08-26T00:00:00.000Z');
      INSERT INTO inbox_items (id, download_key, asset_id, asset_path, filename, kind, mode, service_id, service_label, captured_shot_id, context_revision, state, created_at, updated_at)
      VALUES ('legacy-inbox', 'legacy-download', 'legacy-asset', '素材库/旧镜头.mp4', '旧镜头.mp4', 'video', 'video', 'updream', 'Updream', 'legacy-shot', 3, 'assigned', '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z');
    `);
    if (version === 2) {
      database.exec(`
        ALTER TABLE shots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
        UPDATE shots SET revision = 7 WHERE id = 'legacy-shot';
        INSERT INTO schema_migrations (version, applied_at) VALUES (2, '2026-08-27T00:00:00.000Z');
      `);
    }
    if (brokenForeignKey) {
      database.exec("UPDATE creative_context SET active_shot_id = 'missing-shot' WHERE singleton = 1");
    }
  } finally {
    database.close();
  }
  return databasePath;
}

function downloadInput(id, savePath) {
  return {
    id,
    savePath,
    filename: path.basename(savePath),
    kind: 'video',
    mode: 'video',
    serviceId: 'updream',
    serviceLabel: 'Updream',
    source: 'platform',
  };
}

function testLegacyMigration(version) {
  const projectId = `legacy-project-v${version}`;
  const dataDir = path.join(runRoot, `legacy-v${version}`);
  createLegacyDatabase(dataDir, { version });
  const legacyStore = new ProductionStore({ dataDir, defaultProjectId: projectId });
  try {
    assert.equal(
      legacyStore.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
      CURRENT_SCHEMA_VERSION,
      `v${version} 旧库必须升级至 v${CURRENT_SCHEMA_VERSION}`,
    );
    const legacyShot = legacyStore.getShot('legacy-shot', projectId);
    assert.ok(legacyShot, `v${version} 镜头必须保留`);
    assert.equal(legacyShot.project_id, projectId);
    assert.equal(legacyShot.revision, version === 1 ? 1 : 7, 'v2 已有乐观锁版本不得重置');
    assert.equal(legacyStore.getContext().project_id, projectId);
    assert.equal(legacyStore.getContext().active_shot_id, 'legacy-shot');
    assert.equal(legacyStore.db.prepare('SELECT project_id FROM asset_refs WHERE id = ?').get('legacy-asset').project_id, projectId);
    assert.equal(legacyStore.db.prepare('SELECT project_id FROM inbox_items WHERE id = ?').get('legacy-inbox').project_id, projectId);
    assert.equal(legacyStore.db.prepare('SELECT COUNT(*) AS count FROM shot_asset_uses').get().count, 1);
    assert.equal(legacyStore.snapshot().stats.shots, 1);
    assert.equal(legacyStore.snapshot().stats.inbox, 1);

    const updated = legacyStore.updateShot('legacy-shot', {
      projectId,
      title: '迁移后的镜头更新',
      expectedRevision: legacyShot.revision,
    });
    assert.equal(updated.revision, legacyShot.revision + 1, '迁移后乐观锁仍须工作');

    legacyStore.activateProject(`other-project-v${version}`);
    const sameShotNo = legacyStore.createShot({ shotNo: 'S01', title: '另一剧本也可使用 S01' });
    assert.equal(sameShotNo.project_id, `other-project-v${version}`);
    expectError(
      () => legacyStore.createShot({ shotNo: 's01', title: '同剧重复镜号' }),
      'DUPLICATE_SHOT_NO',
      '迁移后唯一性必须缩小到单个剧本',
    );

    const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter(name => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1, `v${version} 升级只能生成一份迁移前备份`);
    assert.ok(backups[0].startsWith(`production-v${version}-to-v${CURRENT_SCHEMA_VERSION}-`));
    const backup = new DatabaseSync(path.join(dataDir, 'backups', backups[0]));
    try {
      assert.equal(backup.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, version);
      const backupColumns = backup.prepare('PRAGMA table_info(shots)').all().map(column => column.name);
      assert.equal(backupColumns.includes('project_id'), false, '备份不得被 v3 字段污染');
      assert.equal(backupColumns.includes('revision'), version === 2, '备份必须保持原 schema');
      assert.equal(backup.prepare('SELECT title FROM shots WHERE id = ?').get('legacy-shot').title, '旧版镜头');
    } finally {
      backup.close();
    }
    assert.equal(legacyStore.health().ok, true);
  } finally {
    legacyStore.close();
  }
}

try {
  const projectA = 'project-A';
  const projectB = 'project-B';
  store = new ProductionStore({ dataDir: path.join(runRoot, 'data'), defaultProjectId: projectA });
  assert.equal(CURRENT_SCHEMA_VERSION, 4);
  assert.equal(store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
  assert.equal(store.getContext().project_id, projectA);

  const a1 = store.createShot({
    projectId: projectA,
    shotNo: 'S01',
    title: 'A 剧走廊擦肩',
    task: '男主经过后停步回头，女主在后景察觉。',
    episode: '1',
    scene: '教学楼走廊',
    durationSec: 10,
  });
  const a2 = store.createShot({ projectId: projectA, shotNo: 'S02', title: 'A 剧女主反应' });
  assert.equal(store.listShots().length, 2);
  expectError(
    () => store.createShot({ projectId: projectA, shotNo: 's01', title: 'A 剧重复镜号' }),
    'DUPLICATE_SHOT_NO',
  );
  expectError(
    () => store.createShot({ shotNo: 'S-MISSING', title: '不存在的前序', continuityFromId: 'missing-shot' }),
    'SHOT_NOT_FOUND',
  );
  assert.throws(
    () => store.createShot({ shotNo: 'S-BAD-TAIL', title: '非法尾帧', tailFrameStatus: 'invalid' }),
    error => error && error.statusCode === 400,
  );

  const context0 = store.getContext();
  const contextA1 = store.setContext({
    projectId: projectA,
    activeShotId: a1.id,
    mode: 'video',
    serviceId: 'updream',
    expectedRevision: context0.revision,
  });
  const frozenA = store.captureContext({ projectId: projectA, serviceId: 'updream', mode: 'video' });
  const contextA2 = store.setContext({
    projectId: projectA,
    activeShotId: a2.id,
    expectedRevision: contextA1.revision,
  });
  expectError(
    () => store.setContext({ activeShotId: a1.id, expectedRevision: contextA1.revision }),
    'REVISION_CONFLICT',
    '上下文乐观锁必须拒绝过期写入',
  );

  const aDownloadPath = path.join(runRoot, '创作资产', 'A', '生成视频', 'S01.mp4');
  const aInbox = store.recordDownload(downloadInput('download-a-1', aDownloadPath), frozenA);
  assert.equal(aInbox.project_id, projectA);
  assert.equal(aInbox.state, 'assigned');
  assert.equal(aInbox.captured_shot_id, a1.id, '下载完成后必须沿用开始时冻结的镜头');
  const aAssetId = aInbox.asset_id;

  const unassignedA = store.updateInbox(aInbox.id, { projectId: projectA, action: 'unassign' });
  assert.equal(unassignedA.state, 'unassigned');
  const reassignedA = store.updateInbox(aInbox.id, { projectId: projectA, action: 'assign', shotId: a2.id });
  assert.equal(reassignedA.state, 'assigned');
  assert.equal(reassignedA.captured_shot_id, a2.id);

  expectError(
    () => store.linkAssetUse({ projectId: projectA, shotId: a1.id, assetId: aAssetId, purpose: 'continuity_tail' }),
    'INVALID_CONTINUITY_TAIL',
    '普通生成结果不能冒充真实成片尾帧',
  );
  store.db.prepare("UPDATE asset_refs SET origin_type = 'real_output_tail_frame', confirmed_at = ? WHERE id = ?")
    .run('2026-08-30T00:00:00.000Z', aAssetId);
  assert.equal(
    store.linkAssetUse({ projectId: projectA, shotId: a1.id, assetId: aAssetId, purpose: 'continuity_tail' }).ok,
    true,
    '已确认真实成片尾帧仍可正常关联',
  );

  expectError(() => store.updateShot(a1.id, { title: '缺少版本号' }), 'REVISION_REQUIRED');
  const invalidRevisions = [true, false, '1', [1], null, '', 1.5, Number.MAX_SAFE_INTEGER + 1];
  for (const invalidRevision of invalidRevisions) {
    expectError(
      () => store.updateShot(a1.id, { expectedRevision: invalidRevision, title: '非法版本' }),
      'REVISION_REQUIRED',
    );
    expectError(
      () => store.deleteShot(a2.id, { expectedRevision: invalidRevision }),
      'REVISION_REQUIRED',
    );
    expectError(
      () => store.setContext({ expectedRevision: invalidRevision, serviceId: 'grok' }),
      'REVISION_REQUIRED',
    );
  }
  const updatedA1 = store.updateShot(a1.id, {
    projectId: projectA,
    status: 'review',
    stage: 'Seedance 验收',
    tailFrameStatus: 'pending',
    expectedRevision: a1.revision,
  });
  assert.equal(updatedA1.revision, a1.revision + 1);
  expectError(
    () => store.updateShot(a1.id, { projectId: projectA, title: '过期更新', expectedRevision: a1.revision }),
    'REVISION_CONFLICT',
  );

  const contextB = store.activateProject(projectB);
  assert.equal(contextB.project_id, projectB);
  assert.equal(contextB.active_shot_id, null, '切剧后不得保留上一剧本当前镜头');
  assert.equal(store.getContext(projectA), null, '非当前剧本不得读取另一剧本上下文');
  expectError(
    () => store.captureContext({ projectId: projectA }),
    'PROJECT_CONTEXT_MISMATCH',
    '不得伪造另一个剧本的下载上下文',
  );

  const b1 = store.createShot({ projectId: projectB, shotNo: 'S01', title: 'B 剧也有 S01' });
  const b2 = store.createShot({ projectId: projectB, shotNo: 'S02', title: 'B 剧第二镜' });
  assert.equal(store.listShots().length, 2);
  assert.deepEqual(store.listShots().map(shot => shot.project_id), [projectB, projectB]);
  assert.equal(store.listShots(projectA).length, 2);
  assert.equal(store.getShot(a1.id), null, '默认单镜头读取也必须受当前剧本约束');
  expectError(
    () => store.createShot({ projectId: projectB, shotNo: 's01', title: 'B 剧重复镜号' }),
    'DUPLICATE_SHOT_NO',
  );
  expectError(
    () => store.createShot({ projectId: projectB, shotNo: 'S03', title: '跨剧连续', continuityFromId: a1.id }),
    'CROSS_PROJECT_CONTINUITY',
  );
  expectError(
    () => store.updateShot(b1.id, {
      projectId: projectB,
      continuityFromId: a2.id,
      expectedRevision: b1.revision,
    }),
    'CROSS_PROJECT_CONTINUITY',
  );
  const b2WithContinuity = store.updateShot(b2.id, {
    projectId: projectB,
    continuityFromId: b1.id,
    expectedRevision: b2.revision,
  });
  assert.equal(b2WithContinuity.continuity_from_id, b1.id, '同剧连续关系仍应允许');

  expectError(
    () => store.updateShot(a1.id, { expectedRevision: updatedA1.revision, title: '跨剧更新' }),
    'CROSS_PROJECT_SHOT',
  );
  expectError(
    () => store.updateShot(a1.id, { projectId: projectA, expectedRevision: updatedA1.revision, title: '伪造项目更新' }),
    'PROJECT_CONTEXT_MISMATCH',
  );
  expectError(
    () => store.deleteShot(a1.id, { expectedRevision: updatedA1.revision }),
    'CROSS_PROJECT_SHOT',
  );
  expectError(
    () => store.deleteShot(a1.id, { projectId: projectA, expectedRevision: updatedA1.revision }),
    'PROJECT_CONTEXT_MISMATCH',
  );

  const aFrozenResultPath = path.join(runRoot, '创作资产', 'A', '生成视频', 'S01-second.mp4');
  const aFrozenInbox = store.recordDownload(downloadInput('download-a-frozen', aFrozenResultPath), frozenA);
  assert.equal(aFrozenInbox.project_id, projectA, '切到 B 后完成的下载仍必须归 A');
  assert.equal(aFrozenInbox.captured_shot_id, a1.id);

  const frozenB = store.captureContext({ projectId: projectB });
  const bDownloadPath = path.join(runRoot, '创作资产', 'B', '生成视频', 'unassigned.mp4');
  const bInbox = store.recordDownload(downloadInput('download-b-1', bDownloadPath), frozenB);
  assert.equal(bInbox.project_id, projectB);
  assert.equal(bInbox.state, 'unassigned');
  expectError(
    () => store.recordDownload(downloadInput('download-forged-shot', path.join(runRoot, 'forged.mp4')), {
      ...frozenB,
      shotId: a1.id,
    }),
    'CROSS_PROJECT_SHOT',
  );
  expectError(
    () => store.recordDownload(downloadInput('download-a-1', path.join(runRoot, 'B-duplicate-key.mp4')), frozenB),
    'CROSS_PROJECT_INBOX',
  );
  expectError(
    () => store.recordDownload(downloadInput('download-b-same-path', aDownloadPath), frozenB),
    'CROSS_PROJECT_ASSET',
  );

  expectError(() => store.updateInbox(aInbox.id, { action: 'dismiss' }), 'CROSS_PROJECT_INBOX');
  expectError(
    () => store.updateInbox(aInbox.id, { projectId: projectA, action: 'dismiss' }),
    'PROJECT_CONTEXT_MISMATCH',
  );
  expectError(
    () => store.updateInbox(bInbox.id, { projectId: projectB, action: 'assign', shotId: a1.id }),
    'CROSS_PROJECT_SHOT',
  );
  assert.equal(store.updateInbox(bInbox.id, { projectId: projectB, action: 'assign', shotId: b2.id }).state, 'assigned');
  assert.equal(
    store.linkAssetUse({ projectId: projectB, shotId: b1.id, assetId: bInbox.asset_id, purpose: 'reference' }).ok,
    true,
    '同剧资产关联仍应允许',
  );
  const bTailFrame = store.registerFrameAsset({
    projectId: projectB,
    frameKind: 'tail',
    assetPath: path.join(runRoot, '创作资产', 'B', '首帧与尾帧', '尾帧', 'S01-tail.png'),
  });
  assert.equal(bTailFrame.project_id, projectB);
  assert.equal(bTailFrame.origin_type, 'real_output_tail_frame');
  assert.ok(bTailFrame.confirmed_at, '用户显式截取保存的真实尾帧应记录确认时间');
  assert.equal(
    store.linkAssetUse({ projectId: projectB, shotId: b2.id, assetId: bTailFrame.id, purpose: 'continuity_tail' }).ok,
    true,
    '本剧显式截取的真实尾帧应能作为连续性资产',
  );
  expectError(
    () => store.registerFrameAsset({ projectId: projectA, frameKind: 'first', assetPath: path.join(runRoot, 'forged-first.png') }),
    'PROJECT_CONTEXT_MISMATCH',
  );

  expectError(
    () => store.linkAssetUse({ projectId: projectB, shotId: b1.id, assetId: aAssetId, purpose: 'reference' }),
    'CROSS_PROJECT_ASSET',
  );
  expectError(
    () => store.linkAssetUse({ projectId: projectB, shotId: a1.id, assetId: aAssetId, purpose: 'reference' }),
    'CROSS_PROJECT_SHOT',
  );
  expectError(
    () => store.linkAssetUse({ projectId: projectA, shotId: a1.id, assetId: aAssetId, purpose: 'reference' }),
    'PROJECT_CONTEXT_MISMATCH',
  );

  const snapshotB = store.snapshot();
  const snapshotA = store.snapshot(projectA);
  assert.equal(snapshotB.projectId, projectB);
  assert.equal(snapshotB.shots.length, 2);
  assert.equal(snapshotB.inbox.length, 1);
  assert.equal(snapshotB.context.project_id, projectB);
  assert.equal(snapshotA.projectId, projectA);
  assert.equal(snapshotA.shots.length, 2);
  assert.equal(snapshotA.inbox.length, 2);
  assert.equal(snapshotA.context, null, '显式查看非当前剧本快照时不得泄露当前 B 上下文');
  assert.ok(snapshotA.shots.every(shot => shot.project_id === projectA));
  assert.ok(snapshotA.inbox.every(item => item.project_id === projectA));

  const deletableB = store.createShot({ projectId: projectB, shotNo: 'S-DELETE', title: '待删除镜头' });
  assert.deepEqual(
    store.deleteShot(deletableB.id, { projectId: projectB, expectedRevision: deletableB.revision }),
    { ok: true, id: deletableB.id },
  );

  const noShotContextB = store.setContext({
    projectId: projectB,
    activeShotId: null,
    expectedRevision: store.getContext().revision,
  });
  for (let index = 0; index < 201; index++) {
    store.recordDownload(
      downloadInput(`download-page-${index}`, path.join(runRoot, '创作资产', 'B', '生成视频', `page-${index}.mp4`)),
      { ...frozenB, shotId: null, contextRevision: noShotContextB.revision },
    );
  }
  const pagedB = store.snapshot();
  assert.equal(pagedB.stats.inbox, 202, '项目 B 真实入库数不能被首屏 200 条截断');
  assert.equal(pagedB.stats.unassigned, 201);
  assert.equal(pagedB.inbox.length, 200);
  assert.equal(pagedB.inboxPage.total, 202);
  assert.equal(pagedB.inboxPage.hasMore, true);
  assert.equal(store.listInboxPage({ projectId: projectB, offset: 200 }).items.length, 2);
  assert.equal(store.snapshot(projectA).stats.inbox, 2, 'B 的分页入库不得污染 A 的统计');

  {
 const reg=(s,p=store.activeProjectId())=>store.registerManagedAsset({projectId:p,assetPath:s,kind:'image'});
 const old=path.join(runRoot,'创作资产库/剧本/生成图片/a.png'), target=path.join(runRoot,'创作资产库/剧本/人物资产/a.png');
 const source=reg(old), stale=reg(target);
 store.relocateAsset(old,target);
 assert.equal(store.db.prepare('select path from asset_refs where id=?').get(source.id).path,target);
 assert.match(store.db.prepare('select path from asset_refs where id=?').get(stale.id).path,/.asset-history/);
 const exact=path.join(runRoot,'创作资产库/剧本/生成图片/b.png'), legacy=path.join(runRoot,'旧盘/创作资产库/剧本/生成图片/b.png');
 const ex=reg(exact),leg=reg(legacy);store.relocateAsset(exact,target+'b');
 assert.equal(store.db.prepare('select path from asset_refs where id=?').get(leg.id).path,legacy);
 const legacyC=reg(legacy+'c');store.relocateAsset(exact+'c',target+'c');
 assert.equal(store.db.prepare('select path from asset_refs where id=?').get(legacyC.id).path,target+'c');
 const f=path.join(runRoot,'目录甲'),g=path.join(runRoot,'目录乙');
 const fa=reg(path.join(f,'a.png')),fb=reg(path.join(g,'a.png'));
 store.relocateFolder(f,g);
 assert.equal(store.db.prepare('select path from asset_refs where id=?').get(fa.id).path,path.join(g,'a.png'));
 assert.match(store.db.prepare('select path from asset_refs where id=?').get(fb.id).path,/.asset-history/);
 const cross=reg(target+'cross','q'), before=reg(old+'cross');
 assert.throws(()=>store.relocateAsset(old+'cross',target+'cross'),e=>e.code==='CROSS_PROJECT_ASSET');
 assert.equal(store.db.prepare('select path from asset_refs where id=?').get(before.id).path,old+'cross');
 assert.equal(store.health().ok,true);
  }

  const health = store.health();
  assert.equal(health.ok, true);
  assert.deepEqual(health.integrity, [{ integrity_check: 'ok' }]);
  assert.equal(health.foreignKeys.length, 0);

  testLegacyMigration(1);
  testLegacyMigration(2);

  for (const version of [1, 2]) {
    const brokenDataDir = path.join(runRoot, `broken-v${version}`);
    createLegacyDatabase(brokenDataDir, { version, brokenForeignKey: true });
    expectError(
      () => new ProductionStore({ dataDir: brokenDataDir, defaultProjectId: `broken-project-v${version}` }),
      'DATABASE_INTEGRITY',
      `v${version} 孤儿外键必须拒绝迁移`,
    );
    const backups = fs.readdirSync(path.join(brokenDataDir, 'backups')).filter(name => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1, `v${version} 异常旧库也必须先备份再拒绝`);
  }

  console.log('PRODUCTION_STORE_TEST_PASS');
} finally {
  try { if (store) store.close(); } catch {}
  fs.rmSync(runRoot, { recursive: true, force: true });
}
