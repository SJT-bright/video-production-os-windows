'use strict';

// 真实原生 IPC + 本地平台页；所有选文件、拖入、并发测试仅写一次性隔离目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { readArg } = require('./candidate-contract.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function main() {
  const executablePath = readArg(process.argv.slice(2), '--executable');
  const evidenceOut = readArg(process.argv.slice(2), '--evidence-out');
  if (evidenceOut) assert.equal(fs.existsSync(evidenceOut), false, '不能覆盖验收回执');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'video-os-import-names-'));
  const projectRoot = path.join(temp, 'project'), dataDir = path.join(temp, 'data');
  let application;
  const watchdog = setTimeout(() => {
    application?.process()?.kill('SIGKILL');
    console.error('LOCAL_IMPORT_NAMING_NATIVE_TIMEOUT');
    process.exitCode = 1;
  }, 90000).unref();
  try {
    fs.mkdirSync(projectRoot); fs.mkdirSync(dataDir);
    const sources = new Map();
    const source = (relative, bytes) => {
      const filename = path.join(temp, 'input', relative);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes);
      sources.set(filename, bytes);
      return filename;
    };
    const image = source('女主-正面.PNG', PNG);
    const video = source('第01集-镜头07.MP4', Buffer.from('native-import-video-fixture'));
    const externalImage = source('系统浏览器下载图.png', PNG);
    const externalVideo = source('系统浏览器下载视频.mov', Buffer.from('native-import-mov-fixture'));
    const parallelA = source('a/同名角色.png', Buffer.concat([PNG, Buffer.from('A')]));
    const parallelB = source('b/同名角色.png', Buffer.concat([PNG, Buffer.from('B')]));
    application = await _electron.launch({
      ...(executablePath ? { executablePath, args: [] } : { args: [__dirname] }),
      timeout: 30000,
      env: { ...process.env,
        CREATOR_BROWSER_TEST: '1', VIDEO_OS_SMOKE_TEST: '0', VIDEO_OS_PORT: String(5100 + process.pid % 400),
        VIDEO_OS_PROJECT_ROOT: projectRoot, VIDEO_OS_TEST_PROJECT_ROOT: projectRoot, VIDEO_OS_DATA_DIR: dataDir,
        VIDEO_OS_USER_DATA: path.join(temp, 'profile'), OBSIDIAN_VAULT_PATH: path.join(temp, 'obsidian'),
        VIDEO_OS_TEST_OBSIDIAN_VAULT: path.join(temp, 'obsidian'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    const creator = await application.firstWindow();
    await creator.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 22000 });
    const config = await creator.evaluate(() => window.creatorAPI.getConfig());
    const runtime = await application.evaluate(({ app }) => ({
      version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
    }));
    assert.equal(runtime.packaged, !!executablePath);
    assert.equal(runtime.version, require('./package.json').version);
    assert.equal(fs.realpathSync(runtime.userData), fs.realpathSync(path.join(temp, 'profile')));
    assert.equal(fs.realpathSync(config.paths.projectRoot), fs.realpathSync(projectRoot), '测试必须使用隔离项目');
    assert.equal(config.testMode, true);
    await creator.evaluate(() => window.creatorAPI.selectService('gpt', 'image'));
    await application.evaluate(({ dialog }) => {
      globalThis.__importSelections = [];
      dialog.showOpenDialog = async () => {
        const filePaths = globalThis.__importSelections.shift();
        if (!filePaths) throw new Error('测试缺少选文件回执');
        return { canceled: false, filePaths };
      };
    });
    const select = paths => application.evaluate((_electron, paths) => { globalThis.__importSelections.push(paths); }, paths);
    const checkResult = result => {
      assert.equal(result.cancelled, false);
      assert.deepEqual(result.failed, []);
      assert.ok(result.imported > 0);
    };
    const completed = async () => {
      const records = await creator.evaluate(() => window.creatorAPI.getDownloads());
      assert.ok(records.every(record => record.state === 'completed'), JSON.stringify(records));
      assert.ok(records.every(record => record.savePath.startsWith(projectRoot + path.sep)), '落盘不能越过隔离项目');
      return records;
    };
    const checkFile = (record, bytes) => {
      assert.equal(path.basename(record.savePath), record.filename, '记录与落盘名称必须一致');
      assert.deepEqual(fs.readFileSync(record.savePath), bytes);
    };
    await select([image, video]);
    checkResult(await creator.evaluate(() => window.creatorAPI.importAssets()));
    let records = await completed();
    checkFile(records.find(record => record.filename === path.basename(image)), sources.get(image));
    checkFile(records.find(record => record.filename === path.basename(video)), sources.get(video));
    await select([image]);
    checkResult(await creator.evaluate(() => window.creatorAPI.importAssets()));
    records = await completed();
    checkFile(records.find(record => record.filename === '女主-正面 (2).PNG'), PNG);
    checkFile(records.find(record => record.filename === '女主-正面.PNG'), PNG);
    await select([externalImage]);
    checkResult(await creator.evaluate(() => window.creatorAPI.importFiles('image')));
    await select([externalVideo]);
    checkResult(await creator.evaluate(() => window.creatorAPI.importFiles('video')));
    records = await completed();
    for (const file of [externalImage, externalVideo]) checkFile(records.find(record => record.filename === path.basename(file)), sources.get(file));

    await select([parallelA]); await select([parallelB]);
    (await creator.evaluate(() => Promise.all([window.creatorAPI.importAssets(), window.creatorAPI.importAssets()]))).forEach(checkResult);
    records = await completed();
    const parallel = records.filter(record => record.filename.startsWith('同名角色'));
    assert.deepEqual(parallel.map(record => record.filename).sort(), ['同名角色.png', '同名角色 (2).png'].sort());
    assert.deepEqual(parallel.map(record => fs.readFileSync(record.savePath).toString('base64')).sort(), [sources.get(parallelA), sources.get(parallelB)].map(bytes => bytes.toString('base64')).sort());

    checkResult(await creator.evaluate(paths => window.creatorAPI.importDroppedAssets({ paths }), [image, video]));
    records = await completed();
    checkFile(records.find(record => record.filename === '生成图片001.png'), PNG);
    checkFile(records.find(record => record.filename === '生成视频001.mp4'), sources.get(video));
    assert.equal(records.length, 9, '所有手动与拖入记录应各自保留');
    for (const [file, bytes] of sources) assert.deepEqual(fs.readFileSync(file), bytes, '导入不能修改源文件');
    if (evidenceOut) fs.writeFileSync(evidenceOut, `${JSON.stringify({
      status: 'passed', testedAt: new Date().toISOString(), runtime,
      checks: { pickerOriginal: true, externalPickerOriginal: true, dropSequential: true,
        duplicatesUnique: true, concurrentBytesPreserved: true, sourceFilesUnchanged: true },
      isolatedProject: true, formalDataWritten: false,
      imports: records.map(record => ({ filename: record.filename, kind: record.kind, state: record.state })),
    }, null, 2)}\n`, { flag: 'wx' });
    console.log(`LOCAL_IMPORT_NAMING_NATIVE_PASS picker=original externalPicker=original drop=sequential duplicates=unique concurrentBytes=preserved sourceFiles=unchanged packaged=${!!executablePath}`);
  } finally {
    clearTimeout(watchdog);
    if (application) await application.close().catch(() => application.process()?.kill('SIGKILL'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
