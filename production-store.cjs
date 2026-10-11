'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SHOT_STATUSES = new Set(['planned', 'generating', 'review', 'approved', 'blocked']);
const MODES = new Set(['image', 'video']);
const INBOX_STATES = new Set(['unassigned', 'assigned', 'dismissed']);
const ASSET_PURPOSES = new Set(['reference', 'first_frame', 'continuity_tail', 'audio', 'output']);
const CURRENT_SCHEMA_VERSION = 4;
const DEFAULT_PROJECT_ID = 'legacy';

function productionError(message, statusCode = 400, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().slice(0, maxLength);
}

function nullableText(value, maxLength) {
  const text = cleanText(value, maxLength);
  return text || null;
}

function assertOneOf(value, allowed, label) {
  if (!allowed.has(value)) throw productionError(`${label}不受支持`);
  return value;
}

class ProductionStore {
  constructor(options = {}) {
    const { DatabaseSync } = require('node:sqlite');
    this.dataDir = path.resolve(options.dataDir);
    this.defaultProjectId = cleanText(options.defaultProjectId, 100, DEFAULT_PROJECT_ID) || DEFAULT_PROJECT_ID;
    this.databasePath = path.join(this.dataDir, options.filename || 'production.sqlite');
    this.backupDir = path.join(this.dataDir, 'backups');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.databaseExisted = fs.existsSync(this.databasePath) && fs.statSync(this.databasePath).size > 0;
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.migrate();
    } catch (error) {
      try { this.db.close(); } catch {}
      this.db = null;
      throw error;
    }
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  backupBeforeMigration(fromVersion, toVersion) {
    if (!this.databaseExisted) return null;
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.db.exec('PRAGMA wal_checkpoint(FULL)');
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `production-v${fromVersion}-to-v${toVersion}-${stamp}.sqlite`);
    fs.copyFileSync(this.databasePath, backupPath, fs.constants.COPYFILE_EXCL);
    return backupPath;
  }

  assertDatabaseIntegrity(stage) {
    const integrityRows = this.db.prepare('PRAGMA integrity_check').all();
    const foreignKeyRows = this.db.prepare('PRAGMA foreign_key_check').all();
    const structurallyHealthy = integrityRows.length === 1
      && String(integrityRows[0].integrity_check).toLowerCase() === 'ok';
    if (!structurallyHealthy || foreignKeyRows.length) {
      const detail = !structurallyHealthy ? '数据库结构完整性检查失败' : `发现 ${foreignKeyRows.length} 条外键引用异常`;
      throw productionError(`制作台账${stage}${detail}，已停止迁移，请从 data/backups 恢复或修复后重试`, 503, 'DATABASE_INTEGRITY');
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    let version = Number(this.db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version);
    if (version > CURRENT_SCHEMA_VERSION) {
      throw productionError(
        `制作台账版本 v${version} 高于当前程序支持的 v${CURRENT_SCHEMA_VERSION}`,
        503,
        'UNSUPPORTED_SCHEMA',
      );
    }
    if (version > 0 && version < CURRENT_SCHEMA_VERSION) {
      this.backupBeforeMigration(version, CURRENT_SCHEMA_VERSION);
      this.assertDatabaseIntegrity('迁移前');
    } else if (version > 0) {
      this.assertDatabaseIntegrity('启动前');
    }
    if (version < 1) {
      this.backupBeforeMigration(version, 1);
      this.transaction(() => {
      this.db.exec(`
        CREATE TABLE shots (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT '',
          shot_no TEXT NOT NULL COLLATE NOCASE,
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
          updated_at TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          UNIQUE (project_id, shot_no)
        );

        CREATE TABLE creative_context (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          project_id TEXT NOT NULL DEFAULT '',
          active_shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL,
          service_id TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT 'video' CHECK (mode IN ('image', 'video')),
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE asset_refs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT '',
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
          purpose TEXT NOT NULL
            CHECK (purpose IN ('reference', 'first_frame', 'continuity_tail', 'audio', 'output')),
          created_at TEXT NOT NULL,
          PRIMARY KEY (shot_id, asset_id, purpose)
        );

        CREATE TABLE inbox_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL DEFAULT '',
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
          state TEXT NOT NULL DEFAULT 'unassigned'
            CHECK (state IN ('unassigned', 'assigned', 'dismissed')),
          error TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX inbox_state_updated_idx ON inbox_items(state, updated_at DESC);
        CREATE INDEX inbox_shot_updated_idx ON inbox_items(captured_shot_id, updated_at DESC);
        CREATE INDEX shot_status_updated_idx ON shots(status, updated_at DESC);
      `);
      const appliedAt = nowIso();
      this.db.prepare(`
        INSERT INTO creative_context (singleton, project_id, active_shot_id, service_id, mode, revision, updated_at)
        VALUES (1, ?, NULL, '', 'video', 1, ?)
      `).run(this.defaultProjectId, appliedAt);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(appliedAt);
      });
      version = 1;
    }
    if (version < 2) {
      this.transaction(() => {
        const columns = this.db.prepare('PRAGMA table_info(shots)').all();
        if (!columns.some(column => column.name === 'revision')) {
          this.db.exec('ALTER TABLE shots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        }
        this.db.exec('UPDATE shots SET revision = 1 WHERE revision IS NULL OR revision < 1');
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(nowIso());
      });
      version = 2;
    }
    if (version < 3) {
      this.db.exec('PRAGMA foreign_keys = OFF');
      try {
        this.transaction(() => {
          const addProjectColumn = table => {
            const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
            if (!columns.some(column => column.name === 'project_id')) {
              this.db.exec(`ALTER TABLE ${table} ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
            }
            this.db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ''`).run(this.defaultProjectId);
          };
          for (const table of ['shots', 'creative_context', 'asset_refs', 'inbox_items']) addProjectColumn(table);

          // v1/v2 used a global UNIQUE shot_no. Rebuild only this table so two
          // independent dramas may both use S001 without weakening existing IDs.
          this.db.exec(`
            CREATE TABLE shots_v3 (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              shot_no TEXT NOT NULL COLLATE NOCASE,
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
              updated_at TEXT NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              UNIQUE (project_id, shot_no)
            );
            INSERT INTO shots_v3 (
              id, project_id, shot_no, title, task, episode, scene, status, stage,
              duration_sec, tail_frame_status, continuity_from_id, created_at, updated_at, revision
            )
            SELECT id, project_id, shot_no, title, task, episode, scene, status, stage,
              duration_sec, tail_frame_status, continuity_from_id, created_at, updated_at, revision
            FROM shots;
            DROP TABLE shots;
            ALTER TABLE shots_v3 RENAME TO shots;
            DROP INDEX IF EXISTS inbox_state_updated_idx;
            DROP INDEX IF EXISTS inbox_shot_updated_idx;
            CREATE INDEX inbox_state_updated_idx ON inbox_items(project_id, state, updated_at DESC);
            CREATE INDEX inbox_shot_updated_idx ON inbox_items(project_id, captured_shot_id, updated_at DESC);
            CREATE INDEX shot_status_updated_idx ON shots(project_id, status, updated_at DESC);
          `);
          this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(nowIso());
        });
      } finally {
        this.db.exec('PRAGMA foreign_keys = ON');
      }
      version = 3;
    }
    if (version < 4) {
      this.transaction(() => {
        const columns = this.db.prepare('PRAGMA table_info(inbox_items)').all();
        if (!columns.some(column => column.name === 'size_bytes')) {
          this.db.exec('ALTER TABLE inbox_items ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0');
        }
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(nowIso());
      });
      version = 4;
    }
    this.assertDatabaseIntegrity('迁移后');
  }

  getShotAnyProject(id) {
    if (!id) return null;
    return this.db.prepare('SELECT * FROM shots WHERE id = ?').get(String(id)) || null;
  }

  // 资产文件在磁盘上被重命名/移动后，同步修正台账里的路径与文件名。
  registerManagedAsset(input = {}) {
    const projectId = cleanText(input.projectId, 100);
    const assetPath = path.resolve(String(input.assetPath || ''));
    const existing = this.db.prepare('SELECT * FROM asset_refs WHERE path = ?').get(assetPath);
    if (existing && !input.forceNew) {
      if (existing.project_id !== projectId) throw productionError('素材已属于另一个剧本', 409, 'CROSS_PROJECT_ASSET');
      return existing;
    }
    if (existing) {
      if (existing.project_id !== projectId) throw productionError('素材已属于另一个剧本', 409, 'CROSS_PROJECT_ASSET');
      // Keep the old identity and its references, but never attach them to a new copy.
      const retiredPath = path.join(path.dirname(assetPath), '.asset-history', existing.id, path.basename(assetPath));
      this.db.prepare('UPDATE asset_refs SET path = ? WHERE id = ?').run(retiredPath, existing.id);
      this.db.prepare('UPDATE inbox_items SET asset_path = ?, updated_at = ? WHERE asset_path = ?').run(retiredPath, nowIso(), assetPath);
    }
    const id = `asset-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO asset_refs (id, project_id, path, kind, internal_source, origin_type, created_at)
      VALUES (?, ?, ?, ?, 'managed', 'imported_asset', ?)`).run(id, projectId, assetPath, String(input.kind || 'document'), nowIso());
    return this.db.prepare('SELECT * FROM asset_refs WHERE id = ?').get(id);
  }

  relocateAsset(oldPath, newPath, newFilename) {
    const oldClean = String(oldPath || '');
    const newClean = String(newPath || '');
    if (!oldClean || !newClean || oldClean === newClean) return { assets: 0, inbox: 0 };
    return this.transaction(() => {
      // 目录迁移过的项目里，旧记录可能带旧盘符/旧根目录；用“创作资产库”起的尾部路径兜底匹配。
      const tail = oldClean.includes('创作资产库') ? oldClean.slice(oldClean.indexOf('创作资产库')) : oldClean;
      // Exact suffix, not LIKE: underscores/percent signs in filenames are literal.
      const assets = this.db.prepare('UPDATE asset_refs SET path = ? WHERE path = ? OR substr(path, length(path) - length(?) + 1) = ?')
        .run(newClean, oldClean, tail, tail).changes;
      const inbox = this.db.prepare(
        'UPDATE inbox_items SET asset_path = ?, filename = ?, updated_at = ? WHERE asset_path = ? OR substr(asset_path, length(asset_path) - length(?) + 1) = ?',
      ).run(newClean, String(newFilename || path.basename(newClean)), nowIso(), oldClean, tail, tail).changes;
      return { assets, inbox };
    });
  }

  relocateFolder(oldPath, newPath) {
    const prefix = `${oldPath}${path.sep}`;
    const destination = `${newPath}${path.sep}`;
    return this.transaction(() => {
      const assets = this.db.prepare('UPDATE asset_refs SET path = ? || substr(path, length(?) + 1) WHERE substr(path, 1, length(?)) = ?')
        .run(destination, prefix, prefix, prefix).changes;
      const inbox = this.db.prepare('UPDATE inbox_items SET asset_path = ? || substr(asset_path, length(?) + 1), updated_at = ? WHERE substr(asset_path, 1, length(?)) = ?')
        .run(destination, prefix, nowIso(), prefix, prefix).changes;
      return { assets, inbox };
    });
  }

  getShot(id, projectId = this.activeProjectId()) {
    if (!id) return null;
    const safeProjectId = cleanText(projectId, 100, this.activeProjectId()) || this.defaultProjectId;
    return this.db.prepare('SELECT * FROM shots WHERE id = ? AND project_id = ?')
      .get(String(id), safeProjectId) || null;
  }

  activeProjectId() {
    return this.getContext()?.project_id || this.defaultProjectId;
  }

  requireCurrentProjectId(requestedProjectId) {
    const currentProjectId = this.activeProjectId();
    const projectId = requestedProjectId === undefined || requestedProjectId === null || requestedProjectId === ''
      ? currentProjectId
      : cleanText(requestedProjectId, 100);
    if (!projectId) throw productionError('当前剧本不能为空', 400, 'PROJECT_REQUIRED');
    if (projectId !== currentProjectId) {
      throw productionError('请求剧本与当前创作剧本不一致，请刷新后重试', 409, 'PROJECT_CONTEXT_MISMATCH');
    }
    return projectId;
  }

  requireShotInProject(id, projectId) {
    const shot = this.getShotAnyProject(id);
    if (!shot) throw productionError('镜头不存在', 404, 'SHOT_NOT_FOUND');
    if (shot.project_id !== projectId) {
      throw productionError('镜头不属于当前剧本', 409, 'CROSS_PROJECT_SHOT');
    }
    return shot;
  }

  listShots(projectId = this.activeProjectId()) {
    const rows = this.db.prepare(`
      SELECT s.*,
        (SELECT i.filename FROM inbox_items i
          WHERE i.captured_shot_id = s.id AND i.project_id = s.project_id AND i.state != 'dismissed'
          ORDER BY i.updated_at DESC LIMIT 1) AS latest_asset,
        (SELECT COUNT(*) FROM inbox_items i
          WHERE i.captured_shot_id = s.id AND i.project_id = s.project_id AND i.state != 'dismissed') AS asset_count
      FROM shots s
      WHERE s.project_id = ?
      ORDER BY
        CASE WHEN s.episode GLOB '[0-9]*' THEN CAST(s.episode AS INTEGER) ELSE 2147483647 END,
        s.episode COLLATE NOCASE,
        s.shot_no COLLATE NOCASE
    `).all(String(projectId || this.defaultProjectId));
    return rows.map(row => ({ ...row, asset_count: Number(row.asset_count || 0) }));
  }

  getContext(projectId) {
    const row = this.db.prepare(`
      SELECT c.*, s.shot_no, s.title AS shot_title, s.task AS shot_task,
        s.status AS shot_status, s.stage AS shot_stage, s.duration_sec,
        s.tail_frame_status
      FROM creative_context c
      LEFT JOIN shots s ON s.id = c.active_shot_id AND s.project_id = c.project_id
      WHERE c.singleton = 1
    `).get();
    if (!row) return null;
    if (projectId !== undefined && projectId !== null && projectId !== '') {
      const safeProjectId = cleanText(projectId, 100);
      if (row.project_id !== safeProjectId) return null;
    }
    return row;
  }

  listInbox(options = {}) {
    return this.listInboxPage(options).items;
  }

  listInboxPage(options = {}) {
    const projectId = cleanText(options.projectId, 100, this.activeProjectId()) || this.defaultProjectId;
    const includeDismissed = options.includeDismissed === true;
    const requestedLimit = options.limit === undefined || options.limit === null || options.limit === ''
      ? 200 : Number(options.limit);
    const requestedOffset = options.offset === undefined || options.offset === null || options.offset === ''
      ? 0 : Number(options.offset);
    const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 200)) : 200;
    const offset = Number.isInteger(requestedOffset) ? Math.max(0, requestedOffset) : 0;
    const rows = this.db.prepare(`
      SELECT i.*, s.shot_no, s.title AS shot_title
      FROM inbox_items i
      LEFT JOIN shots s ON s.id = i.captured_shot_id AND s.project_id = i.project_id
      WHERE i.project_id = ? AND (? = 1 OR i.state != 'dismissed')
      ORDER BY
        CASE i.state WHEN 'unassigned' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
        i.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(projectId, includeDismissed ? 1 : 0, limit, offset);
    const total = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM inbox_items WHERE project_id = ? AND (? = 1 OR state != 'dismissed')
    `).get(projectId, includeDismissed ? 1 : 0).count || 0);
    return {
      items: rows,
      pagination: { limit, offset, total, hasMore: offset + rows.length < total },
    };
  }

  snapshot(projectId = this.activeProjectId()) {
    const safeProjectId = cleanText(projectId, 100, this.defaultProjectId) || this.defaultProjectId;
    const shots = this.listShots(safeProjectId);
    const context = this.getContext(safeProjectId);
    const inboxPage = this.listInboxPage({ limit: 200, projectId: safeProjectId });
    const inbox = inboxPage.items;
    const inboxStats = this.db.prepare(`
      SELECT
        COUNT(*) AS inbox,
        SUM(CASE WHEN state = 'unassigned' THEN 1 ELSE 0 END) AS unassigned
      FROM inbox_items
      WHERE project_id = ? AND state != 'dismissed'
    `).get(safeProjectId);
    const statuses = Object.fromEntries([...SHOT_STATUSES].map(status => [status, 0]));
    for (const shot of shots) statuses[shot.status] = (statuses[shot.status] || 0) + 1;
    return {
      available: true,
      databasePath: this.databasePath,
      projectId: safeProjectId,
      shots,
      context,
      inbox,
      inboxPage: inboxPage.pagination,
      stats: {
        shots: shots.length,
        inbox: Number(inboxStats.inbox || 0),
        unassigned: Number(inboxStats.unassigned || 0),
        statuses,
      },
    };
  }

  createShot(input = {}) {
    const projectId = this.requireCurrentProjectId(input.projectId);
    const shotNo = cleanText(input.shotNo, 40).toUpperCase();
    const title = cleanText(input.title, 160);
    if (!shotNo) throw productionError('请填写镜号');
    if (!title) throw productionError('请填写镜头任务标题');
    const status = input.status ? assertOneOf(String(input.status), SHOT_STATUSES, '镜头状态') : 'planned';
    const durationSec = input.durationSec === '' || input.durationSec === undefined || input.durationSec === null
      ? null : Number(input.durationSec);
    if (durationSec !== null && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 900)) {
      throw productionError('镜头时长必须是 1—900 秒的整数');
    }
    const id = `shot-${crypto.randomUUID()}`;
    const continuityFromId = nullableText(input.continuityFromId, 100);
    if (continuityFromId && continuityFromId === id) throw productionError('镜头不能连续自自身');
    if (continuityFromId) {
      const continuityShot = this.getShotAnyProject(continuityFromId);
      if (!continuityShot) throw productionError('前序镜头不存在', 404, 'SHOT_NOT_FOUND');
      if (continuityShot.project_id !== projectId) {
        throw productionError('不能把其他剧本的镜头设为前序镜头', 409, 'CROSS_PROJECT_CONTINUITY');
      }
    }
    const tailFrameStatus = input.tailFrameStatus === undefined
      ? 'none' : assertOneOf(String(input.tailFrameStatus), new Set(['none', 'pending', 'confirmed']), '尾帧状态');
    const now = nowIso();
    try {
      this.db.prepare(`
        INSERT INTO shots (
          id, project_id, shot_no, title, task, episode, scene, status, stage, duration_sec,
          tail_frame_status, continuity_from_id, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        id, projectId, shotNo, title, cleanText(input.task, 4000), cleanText(input.episode, 40),
        cleanText(input.scene, 120), status, cleanText(input.stage, 80, 'prompt') || 'prompt',
        durationSec, tailFrameStatus, continuityFromId, now, now,
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw productionError(`当前剧本的镜号 ${shotNo} 已存在`, 409, 'DUPLICATE_SHOT_NO');
      }
      throw error;
    }
    return this.getShot(id, projectId);
  }

  updateShot(id, input = {}) {
    const expectedRevision = input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw productionError('镜头更新需要当前版本号，请刷新后重试', 400, 'REVISION_REQUIRED');
    }
    const projectId = this.requireCurrentProjectId(input.projectId);
    const previous = this.requireShotInProject(id, projectId);
    const shotNo = input.shotNo === undefined ? previous.shot_no : cleanText(input.shotNo, 40).toUpperCase();
    const title = input.title === undefined ? previous.title : cleanText(input.title, 160);
    if (!shotNo || !title) throw productionError('镜号和镜头任务标题不能为空');
    const status = input.status === undefined ? previous.status : assertOneOf(String(input.status), SHOT_STATUSES, '镜头状态');
    const durationSec = input.durationSec === undefined
      ? previous.duration_sec
      : (input.durationSec === '' || input.durationSec === null ? null : Number(input.durationSec));
    if (durationSec !== null && (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > 900)) {
      throw productionError('镜头时长必须是 1—900 秒的整数');
    }
    const continuityFromId = input.continuityFromId === undefined
      ? previous.continuity_from_id : nullableText(input.continuityFromId, 100);
    if (continuityFromId && continuityFromId === id) throw productionError('镜头不能连续自自身');
    if (continuityFromId) {
      const continuityShot = this.getShotAnyProject(continuityFromId);
      if (!continuityShot) throw productionError('前序镜头不存在', 404, 'SHOT_NOT_FOUND');
      if (continuityShot.project_id !== projectId) {
        throw productionError('不能把其他剧本的镜头设为前序镜头', 409, 'CROSS_PROJECT_CONTINUITY');
      }
    }
    const tailFrameStatus = input.tailFrameStatus === undefined ? previous.tail_frame_status : String(input.tailFrameStatus);
    if (!['none', 'pending', 'confirmed'].includes(tailFrameStatus)) throw productionError('尾帧状态不受支持');
    try {
      const update = this.db.prepare(`
        UPDATE shots SET shot_no = ?, title = ?, task = ?, episode = ?, scene = ?, status = ?,
          stage = ?, duration_sec = ?, tail_frame_status = ?, continuity_from_id = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND project_id = ? AND revision = ?
      `).run(
        shotNo, title,
        input.task === undefined ? previous.task : cleanText(input.task, 4000),
        input.episode === undefined ? previous.episode : cleanText(input.episode, 40),
        input.scene === undefined ? previous.scene : cleanText(input.scene, 120),
        status,
        input.stage === undefined ? previous.stage : (cleanText(input.stage, 80) || 'prompt'),
        durationSec, tailFrameStatus, continuityFromId, nowIso(), id, projectId, expectedRevision,
      );
      if (Number(update.changes) !== 1) {
        const latest = this.getShotAnyProject(id);
        if (!latest) throw productionError('镜头不存在', 404, 'SHOT_NOT_FOUND');
        if (latest.project_id !== projectId) throw productionError('镜头不属于当前剧本', 409, 'CROSS_PROJECT_SHOT');
        throw productionError('镜头已在其他窗口更新，请刷新后重试', 409, 'REVISION_CONFLICT');
      }
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        throw productionError(`当前剧本的镜号 ${shotNo} 已存在`, 409, 'DUPLICATE_SHOT_NO');
      }
      throw error;
    }
    return this.getShot(id, projectId);
  }

  deleteShot(id, input = {}) {
    const expectedRevision = input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw productionError('删除镜头需要当前版本号，请刷新后重试', 400, 'REVISION_REQUIRED');
    }
    const projectId = this.requireCurrentProjectId(input.projectId);
    const shot = this.requireShotInProject(id, projectId);
    const context = this.getContext();
    if (context && context.active_shot_id === id) throw productionError('请先取消当前镜头，再删除', 409, 'ACTIVE_SHOT');
    const linked = Number(this.db.prepare("SELECT COUNT(*) AS count FROM inbox_items WHERE captured_shot_id = ? AND project_id = ? AND state != 'dismissed'").get(id, projectId).count);
    if (linked > 0) throw productionError(`该镜头仍关联 ${linked} 个入库结果，请先改派或忽略`, 409, 'SHOT_HAS_ASSETS');
    const deleted = this.db.prepare('DELETE FROM shots WHERE id = ? AND project_id = ? AND revision = ?')
      .run(id, projectId, expectedRevision);
    if (Number(deleted.changes) !== 1) {
      const latest = this.getShotAnyProject(id);
      if (!latest) throw productionError('镜头不存在', 404, 'SHOT_NOT_FOUND');
      if (latest.project_id !== projectId) throw productionError('镜头不属于当前剧本', 409, 'CROSS_PROJECT_SHOT');
      throw productionError('镜头已在其他窗口更新，请刷新后重试', 409, 'REVISION_CONFLICT');
    }
    return { ok: true, id };
  }

  setContext(input = {}) {
    const expectedRevision = input.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw productionError('创作上下文更新需要当前版本号，请刷新后重试', 400, 'REVISION_REQUIRED');
    }
    const current = this.getContext();
    if (!current) throw productionError('创作上下文不可用', 503, 'CONTEXT_UNAVAILABLE');
    const projectId = input.projectId === undefined
      ? current.project_id
      : (cleanText(input.projectId, 100) || this.defaultProjectId);
    const projectChanged = projectId !== current.project_id;
    const activeShotId = input.activeShotId === undefined
      ? (projectChanged ? null : current.active_shot_id)
      : nullableText(input.activeShotId, 100);
    if (activeShotId && !this.getShot(activeShotId, projectId)) {
      throw productionError('要设为当前的镜头不存在或不属于当前剧本', 404, 'CROSS_PROJECT_SHOT');
    }
    const mode = input.mode === undefined ? current.mode : assertOneOf(String(input.mode), MODES, '创作模式');
    const serviceId = input.serviceId === undefined ? current.service_id : cleanText(input.serviceId, 80);
    const update = this.db.prepare(`
      UPDATE creative_context
      SET project_id = ?, active_shot_id = ?, service_id = ?, mode = ?, revision = revision + 1, updated_at = ?
      WHERE singleton = 1 AND revision = ?
    `).run(projectId, activeShotId, serviceId, mode, nowIso(), expectedRevision);
    if (Number(update.changes) !== 1) throw productionError('创作上下文已变化，请刷新后重试', 409, 'REVISION_CONFLICT');
    return this.getContext();
  }

  activateProject(projectId) {
    const safeProjectId = cleanText(projectId, 100);
    if (!safeProjectId) throw productionError('当前剧本不能为空');
    const current = this.getContext();
    if (!current) throw productionError('创作上下文不可用', 503, 'CONTEXT_UNAVAILABLE');
    if (current.project_id === safeProjectId) return current;
    this.db.prepare(`
      UPDATE creative_context
      SET project_id = ?, active_shot_id = NULL, revision = revision + 1, updated_at = ?
      WHERE singleton = 1
    `).run(safeProjectId, nowIso());
    return this.getContext();
  }

  captureContext(overrides = {}) {
    const context = this.getContext();
    if (overrides.projectId !== undefined) this.requireCurrentProjectId(overrides.projectId);
    return {
      shotId: context && context.active_shot_id || null,
      shotNo: context && context.shot_no || '',
      shotTitle: context && context.shot_title || '',
      contextRevision: Number(context && context.revision || 0),
      projectId: context && context.project_id || this.defaultProjectId,
      mode: MODES.has(overrides.mode) ? overrides.mode : (context && context.mode || 'video'),
      serviceId: cleanText(overrides.serviceId, 80, context && context.service_id || ''),
      capturedAt: nowIso(),
    };
  }

  recordDownload(input = {}, snapshot = {}) {
    const downloadKey = cleanText(input.downloadKey || input.id, 180);
    const assetPath = cleanText(input.assetPath || input.savePath, 4096);
    const filename = cleanText(input.filename || path.basename(assetPath), 512);
    const mode = assertOneOf(input.mode === 'image' ? 'image' : 'video', MODES, '创作模式');
    if (!downloadKey || !assetPath || !filename) throw productionError('下载入库信息不完整');
    const capturedShotId = nullableText(snapshot.shotId, 100);
    const projectId = cleanText(snapshot.projectId, 100, this.activeProjectId()) || this.defaultProjectId;
    const capturedShot = capturedShotId ? this.getShotAnyProject(capturedShotId) : null;
    if (capturedShot && capturedShot.project_id !== projectId) {
      throw productionError('下载快照中的镜头不属于冻结剧本', 409, 'CROSS_PROJECT_SHOT');
    }
    const shotExists = !!capturedShot;
    const assetId = `asset-${crypto.randomUUID()}`;
    const inboxId = `inbox-${crypto.randomUUID()}`;
    const now = nowIso();
    return this.transaction(() => {
      const existingInbox = this.db.prepare('SELECT * FROM inbox_items WHERE download_key = ?').get(downloadKey);
      if (existingInbox && existingInbox.project_id !== projectId) {
        throw productionError('该下载记录已经归属于另一个剧本', 409, 'CROSS_PROJECT_INBOX');
      }
      let asset = this.db.prepare('SELECT * FROM asset_refs WHERE path = ?').get(assetPath);
      if (!asset) {
        this.db.prepare(`
          INSERT INTO asset_refs (id, project_id, path, kind, internal_source, origin_type, confirmed_at, created_at)
          VALUES (?, ?, ?, ?, 'generated', 'generated_output', ?, ?)
        `).run(assetId, projectId, assetPath, cleanText(input.kind, 40, 'other'), now, now);
        asset = this.db.prepare('SELECT * FROM asset_refs WHERE id = ?').get(assetId);
      } else if (asset.project_id !== projectId) {
        throw productionError('该文件已经归属于另一个剧本', 409, 'CROSS_PROJECT_ASSET');
      }
      this.db.prepare(`
        INSERT INTO inbox_items (
          id, project_id, download_key, asset_id, asset_path, filename, kind, mode, service_id,
          service_label, source, captured_shot_id, context_revision, state, error, size_bytes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(download_key) DO UPDATE SET
          asset_id = excluded.asset_id,
          asset_path = excluded.asset_path,
          filename = excluded.filename,
          captured_shot_id = excluded.captured_shot_id,
          context_revision = excluded.context_revision,
          state = excluded.state,
          error = excluded.error,
          size_bytes = excluded.size_bytes,
          updated_at = excluded.updated_at
      `).run(
        inboxId, projectId, downloadKey, asset.id, assetPath, filename, cleanText(input.kind, 40, 'other'), mode,
        cleanText(input.serviceId, 80), cleanText(input.serviceLabel, 160), cleanText(input.source, 40, 'platform'),
        shotExists ? capturedShotId : null, Number(snapshot.contextRevision || 0),
        shotExists ? 'assigned' : 'unassigned', shotExists || !capturedShotId ? '' : '下载开始时的镜头已不存在',
        Math.max(0, Number(input.sizeBytes) || 0), now, now,
      );
      if (shotExists) {
        this.db.prepare(`
          INSERT OR IGNORE INTO shot_asset_uses (shot_id, asset_id, purpose, created_at)
          VALUES (?, ?, 'output', ?)
        `).run(capturedShotId, asset.id, now);
      }
      return this.db.prepare(`
        SELECT i.*, s.shot_no, s.title AS shot_title
        FROM inbox_items i LEFT JOIN shots s ON s.id = i.captured_shot_id AND s.project_id = i.project_id
        WHERE i.download_key = ? AND i.project_id = ?
      `).get(downloadKey, projectId);
    });
  }

  registerFrameAsset(input = {}) {
    const projectId = this.requireCurrentProjectId(input.projectId);
    const assetPath = cleanText(input.assetPath, 4096);
    const frameKind = String(input.frameKind || 'first') === 'tail' ? 'tail' : 'first';
    if (!assetPath) throw productionError('首尾帧文件路径不能为空');
    const originType = frameKind === 'tail' ? 'real_output_tail_frame' : 'real_output_first_frame';
    const confirmedAt = input.confirmed === false ? null : nowIso();
    const existing = this.db.prepare('SELECT * FROM asset_refs WHERE path = ?').get(assetPath);
    if (existing && existing.project_id !== projectId) {
      throw productionError('该首尾帧已经归属于另一个剧本', 409, 'CROSS_PROJECT_ASSET');
    }
    const assetId = existing?.id || `asset-${crypto.randomUUID()}`;
    if (existing) {
      this.db.prepare(`
        UPDATE asset_refs
        SET kind = 'image', internal_source = 'captured_from_video', origin_type = ?, confirmed_at = ?
        WHERE id = ? AND project_id = ?
      `).run(originType, confirmedAt, assetId, projectId);
    } else {
      this.db.prepare(`
        INSERT INTO asset_refs (id, project_id, path, kind, internal_source, origin_type, confirmed_at, created_at)
        VALUES (?, ?, ?, 'image', 'captured_from_video', ?, ?, ?)
      `).run(assetId, projectId, assetPath, originType, confirmedAt, nowIso());
    }
    return this.db.prepare('SELECT * FROM asset_refs WHERE id = ? AND project_id = ?').get(assetId, projectId);
  }

  updateInbox(id, input = {}) {
    const projectId = this.requireCurrentProjectId(input.projectId);
    const item = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(String(id));
    if (!item) throw productionError('入库记录不存在', 404, 'INBOX_NOT_FOUND');
    if (item.project_id !== projectId) {
      throw productionError('入库记录不属于当前剧本', 409, 'CROSS_PROJECT_INBOX');
    }
    const action = String(input.action || 'assign');
    let shotId = item.captured_shot_id;
    let state = item.state;
    if (action === 'assign') {
      shotId = nullableText(input.shotId, 100);
      if (!shotId) throw productionError('请选择当前剧本中存在的镜头', 404, 'SHOT_NOT_FOUND');
      this.requireShotInProject(shotId, projectId);
      state = 'assigned';
    } else if (action === 'unassign') {
      shotId = null;
      state = 'unassigned';
    } else if (action === 'dismiss') {
      state = 'dismissed';
    } else if (action === 'restore') {
      state = shotId ? 'assigned' : 'unassigned';
    } else {
      throw productionError('入库操作不受支持');
    }
    assertOneOf(state, INBOX_STATES, '入库状态');
    this.transaction(() => {
      if (item.asset_id) this.db.prepare("DELETE FROM shot_asset_uses WHERE asset_id = ? AND purpose = 'output'").run(item.asset_id);
      this.db.prepare('UPDATE inbox_items SET captured_shot_id = ?, state = ?, error = ?, updated_at = ? WHERE id = ? AND project_id = ?')
        .run(shotId, state, '', nowIso(), id, projectId);
      if (state === 'assigned' && item.asset_id) {
        this.db.prepare("INSERT OR IGNORE INTO shot_asset_uses (shot_id, asset_id, purpose, created_at) VALUES (?, ?, 'output', ?)")
          .run(shotId, item.asset_id, nowIso());
      }
    });
    return this.db.prepare(`
      SELECT i.*, s.shot_no, s.title AS shot_title
      FROM inbox_items i LEFT JOIN shots s ON s.id = i.captured_shot_id AND s.project_id = i.project_id
      WHERE i.id = ? AND i.project_id = ?
    `).get(id, projectId);
  }

  linkAssetUse(input = {}) {
    const projectId = this.requireCurrentProjectId(input.projectId);
    const shotId = cleanText(input.shotId, 100);
    const assetId = cleanText(input.assetId, 100);
    const purpose = assertOneOf(String(input.purpose || 'reference'), ASSET_PURPOSES, '资产用途');
    const shot = this.getShotAnyProject(shotId);
    const asset = this.db.prepare('SELECT * FROM asset_refs WHERE id = ?').get(assetId);
    if (!shot) throw productionError('镜头不存在', 404, 'SHOT_NOT_FOUND');
    if (!asset) throw productionError('资产不存在', 404, 'ASSET_NOT_FOUND');
    if (shot.project_id !== projectId) {
      throw productionError('镜头不属于当前剧本', 409, 'CROSS_PROJECT_SHOT');
    }
    if (asset.project_id !== projectId || shot.project_id !== asset.project_id) {
      throw productionError('镜头与资产不属于同一剧本', 409, 'CROSS_PROJECT_ASSET');
    }
    if (purpose === 'continuity_tail' && (asset.origin_type !== 'real_output_tail_frame' || !asset.confirmed_at)) {
      throw productionError('只有已确认的真实成片尾帧才能作为连续镜头参考', 409, 'INVALID_CONTINUITY_TAIL');
    }
    this.db.prepare('INSERT OR IGNORE INTO shot_asset_uses (shot_id, asset_id, purpose, created_at) VALUES (?, ?, ?, ?)')
      .run(shotId, assetId, purpose, nowIso());
    return { ok: true, shotId, assetId, purpose };
  }

  health() {
    const integrityRows = this.db.prepare('PRAGMA integrity_check').all();
    const foreignKeyRows = this.db.prepare('PRAGMA foreign_key_check').all();
    return {
      ok: integrityRows.length === 1 && String(integrityRows[0].integrity_check).toLowerCase() === 'ok' && foreignKeyRows.length === 0,
      integrity: integrityRows,
      foreignKeys: foreignKeyRows,
      databasePath: this.databasePath,
    };
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

module.exports = {
  ProductionStore,
  productionError,
  SHOT_STATUSES,
  CURRENT_SCHEMA_VERSION,
};
