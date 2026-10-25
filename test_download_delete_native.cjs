'use strict';
// Real packaged preload/IPC with temporary documents. Dialog replies are injected.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedElectron}=require('./test-isolated-electron-cdp.cjs');
async function main(){
  const version=require('./package.json').version;
  const executablePath=process.env.DOWNLOAD_DELETE_EXECUTABLE || (process.platform==='darwin'
    ?path.join(__dirname,'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app/Contents/MacOS/VideoProductionOS')
    :path.join(__dirname,'dist/视频制作OS-win32-x64/视频制作OS.exe'));
  const evidence=path.resolve(process.env.DOWNLOAD_DELETE_EVIDENCE || path.join(__dirname,'test-artifacts/latest-release-native/download-delete'));
  assert.equal(fs.existsSync(evidence),false);fs.mkdirSync(evidence,{recursive:true});
  const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'video-os-episodes-download-delete-'));
  for(const dir of ['project','profile','data','obsidian'])fs.mkdirSync(path.join(temp,dir));
  const folder='下载删除隔离验收',downloadRoot=path.join(temp,'project/创作资产库',folder,'浏览器下载');
  fs.mkdirSync(downloadRoot,{recursive:true});
  for(const name of ['保留.txt','删除一.txt','删除二.txt'])fs.writeFileSync(path.join(downloadRoot,name),'temporary verification document');
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,CREATOR_BROWSER_TEST:'1',VIDEO_OS_SMOKE_TEST:'0',VIDEO_OS_TAB_MENU_TEST:'0',VIDEO_OS_PORT:String(port),
    VIDEO_OS_PROJECT_ROOT:path.join(temp,'project'),VIDEO_OS_TEST_PROJECT_ROOT:path.join(temp,'project'),VIDEO_OS_USER_DATA:path.join(temp,'profile'),
    VIDEO_OS_DATA_DIR:path.join(temp,'data'),OBSIDIAN_VAULT_PATH:path.join(temp,'obsidian'),VIDEO_OS_TEST_OBSIDIAN_VAULT:path.join(temp,'obsidian')};
  delete env.ELECTRON_RUN_AS_NODE;
  const receipt={status:'running',version,platform:process.platform,scope:{actualPackagedApp:true,nativePreloadIPC:true,dialogRepliesInjected:true,realTemporaryDocumentUnlink:true,formalAppTouched:false}};
  let app;
  try{
    app=await launchIsolatedElectron({executablePath,env});
    receipt.runtime=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}));
    assert.equal(receipt.runtime.version,version);assert.equal(receipt.runtime.packaged,true);
    const projectId=await app.renderer(async folder=>{
      const data=await fetch('/api/creative-projects').then(r=>r.json());const p=data.projects.find(p=>p.name===folder);if(!p)throw Error('isolated project missing');
      await fetch('/api/creative-projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'activate',id:p.id})});
      return p.id;
    },folder);
    const end=Date.now()+20000;
    while(!await app.renderer(id=>state.projectId===id,projectId)){
      if(Date.now()>end)throw Error('project UI did not settle');await new Promise(r=>setTimeout(r,100));
    }
    await app.evaluate(({dialog})=>{
      global.__downloadDeleteProbe={prompts:[],reply:{response:0,checkboxChecked:true}};
      dialog.showMessageBox=async (...args)=>{const p=global.__downloadDeleteProbe;p.prompts.push(args.at(-1));return p.reply;};return true;
    });
    const remove=name=>app.renderer(token=>window.creatorAPI.deleteBrowserDownload(token),folder+'/浏览器下载/'+name);
    assert.equal(await remove('保留.txt'),false);assert.ok(fs.existsSync(path.join(downloadRoot,'保留.txt')));
    await app.evaluate(()=>{global.__downloadDeleteProbe.reply={response:1,checkboxChecked:true};return true;});
    assert.equal(await remove('删除一.txt'),true);assert.equal(fs.existsSync(path.join(downloadRoot,'删除一.txt')),false);
    assert.equal(await remove('删除二.txt'),true);assert.equal(fs.existsSync(path.join(downloadRoot,'删除二.txt')),false);
    const prompts=await app.evaluate(()=>global.__downloadDeleteProbe.prompts);
    assert.equal(prompts.length,2,'checked cancellation must not grant; checked approval must skip next prompt');
    for(const p of prompts){assert.equal(p.defaultId,0);assert.equal(p.cancelId,0);assert.equal(p.checkboxChecked,false);assert.match(p.checkboxLabel,/5 分钟内不再询问.*浏览器下载/);assert.match(p.detail,/不会移到废纸篓/);}
    assert.ok(fs.existsSync(path.join(downloadRoot,'保留.txt')));receipt.checks={cancelKeepsFile:true,cancelCheckedDoesNotGrant:true,nativeCheckboxDefaultAndWarning:true,optInSkipsNextPrompt:true,realFilesDeleted:true,unselectedKept:true};receipt.status='passed';
  }finally{
    if(app){await app.close();assert.notEqual(app.process().exitCode,null);receipt.processExited=true;}
    fs.rmSync(temp,{recursive:true,force:true});receipt.fixtureCleaned=!fs.existsSync(temp);
    fs.writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  }
  console.log('DOWNLOAD_DELETE_NATIVE_PASS version='+version+' platform='+process.platform+' checks=6 ownedAppExited=true');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
