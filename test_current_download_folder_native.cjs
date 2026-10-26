'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {launchIsolatedElectron}=require('./test-isolated-electron-cdp.cjs');
async function main(){
  assert.ok(process.env.CURRENT_FOLDER_EXECUTABLE && fs.existsSync(process.env.CURRENT_FOLDER_EXECUTABLE), 'isolated executable must exist');
  const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'video-os-episodes-current-folder-'));
  const projectRoot=path.join(root,'project'),folder='存入目录隔离',assets=path.join(projectRoot,'创作资产库',folder);
  for(const dir of ['project','profile','data','obsidian'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const episode of [14,60])fs.mkdirSync(path.join(assets,'生成视频/核绘',`第${episode}集`),{recursive:true});
  let app,server;const receipt={status:'running',formalAppTouched:false};
  const evidence=process.env.CURRENT_FOLDER_EVIDENCE;assert.ok(evidence&&!fs.existsSync(evidence));fs.mkdirSync(evidence,{recursive:true});
  const wait=async(fn,label)=>{const end=Date.now()+25000;while(Date.now()<end){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,100));}throw Error(label);};
  try{
    let release;server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="fixture.mp4"'});res.write('isolated video bytes');release=()=>res.end(' end');});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const portProbe=http.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
    const env={...process.env,CREATOR_BROWSER_TEST:'1',VIDEO_OS_SMOKE_TEST:'0',VIDEO_OS_PORT:String(port),VIDEO_OS_PROJECT_ROOT:projectRoot,VIDEO_OS_TEST_PROJECT_ROOT:projectRoot,VIDEO_OS_DATA_DIR:path.join(root,'data'),VIDEO_OS_USER_DATA:path.join(root,'profile'),OBSIDIAN_VAULT_PATH:path.join(root,'obsidian'),VIDEO_OS_TEST_OBSIDIAN_VAULT:path.join(root,'obsidian')};delete env.ELECTRON_RUN_AS_NODE;
    app=await launchIsolatedElectron({executablePath:process.env.CURRENT_FOLDER_EXECUTABLE,env});
    const id=await app.renderer(async name=>{const p=(await fetch('/api/creative-projects').then(r=>r.json())).projects.find(p=>p.name===name);if(!p)throw Error('fixture project missing');await fetch('/api/creative-projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'activate',id:p.id})});return p.id;},folder);
    await wait(()=>app.renderer(id=>state.projectId===id,id),'project ready');
    const chosen=folder+'/生成视频/核绘/第14集';
    // Exercise the actual current-import label synchronization, not a direct download override.
    await app.renderer(chosen=>{state.quickAssetFolder=chosen;updateQuickDropLabel();return true;},chosen);
    await app.renderer(async()=>{await new Promise(r=>setTimeout(r,100));return true;});
    const sourceId=await wait(()=>app.evaluate(({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().includes('creator-fixture.html?service='))?.id),'platform fixture');
    await app.evaluate(({webContents},arg)=>{webContents.fromId(arg.id).downloadURL(arg.url);return true;},{id:sourceId,url:`http://127.0.0.1:${server.address().port}/fixture.mp4`});
    await wait(()=>Promise.resolve(release),'download started');
    const journal=path.join(root,'data/video-download-review/reviews.json');
    const entry=await wait(()=>{if(!fs.existsSync(journal))return null;return Object.values(JSON.parse(fs.readFileSync(journal)).entries)[0];},'journal');
    assert.equal(entry.productionSnapshot.selectedDownloadFolder,chosen);
    // A later selection must affect only later downloads, not the in-flight snapshot.
    await app.renderer(async arg=>{state.quickAssetFolder=arg.path;updateQuickDropLabel();return true;},{path:folder+'/生成视频/核绘/第60集'});
    release();
    await wait(()=>app.evaluate(async({webContents})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().includes('/assets/ui/download-review.html'));if(!wc)return false;return wc.executeJavaScript(`(()=>{const b=document.querySelector('[data-choice="editable"]');if(!b)return false;b.click();return true;})()`);}), 'choice');
    const downloaded=await wait(()=>app.renderer(async()=>{const items=await window.creatorAPI.getDownloads();return items.find(d=>d.state==='completed'&&d.kind==='video');}),'archive completed');
    const expected=path.join(assets,'生成视频/核绘/第14集/可剪辑');assert.equal(path.dirname(downloaded.savePath),expected);
    assert.ok(fs.existsSync(downloaded.savePath));assert.equal(fs.readdirSync(path.join(assets,'生成视频/核绘/第60集')).length,0);
    receipt.status='passed';receipt.checks={currentImportLabelSyncsNativeTarget:true,downloadJournalCaptures14:true,laterSelection60DoesNotMoveInFlight:true,actualDownloadedFileUnder14:true,noFileUnder60:true};
  }finally{
    if(app){await app.close();assert.ok(app.process().exitCode!==null || app.process().signalCode!==null);receipt.processExited=true;}
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
    fs.rmSync(root,{recursive:true,force:true});receipt.fixtureCleaned=true;fs.writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));
  }
  console.log('CURRENT_DOWNLOAD_FOLDER_NATIVE_PASS current14=true later60DoesNotRedirect=true');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
