'use strict';
// Exact isolated packaged App; only local tab-strip fixture elements are added.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedElectron}=require('./test-isolated-electron-cdp.cjs');
async function main(){
  const version=require('./package.json').version;
  const executablePath=process.env.WHEEL_TEST_EXECUTABLE || (process.platform==='darwin'
    ?path.join(__dirname,'dist/public-release/视频制作 OS-darwin-universal/视频制作 OS.app/Contents/MacOS/VideoProductionOS')
    :path.join(__dirname,'dist/视频制作OS-win32-x64/视频制作OS.exe'));
  const evidence=path.resolve(process.env.WHEEL_TEST_EVIDENCE || path.join(__dirname,'test-artifacts/latest-release-native/tab-wheel'));
  assert.equal(fs.existsSync(evidence),false);fs.mkdirSync(evidence,{recursive:true});
  const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'video-os-episodes-wheel-'));
  for(const dir of ['project','profile','data','obsidian'])fs.mkdirSync(path.join(temp,dir));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,CREATOR_BROWSER_TEST:'1',VIDEO_OS_SMOKE_TEST:'0',VIDEO_OS_TAB_MENU_TEST:'0',VIDEO_OS_PORT:String(port),
    VIDEO_OS_PROJECT_ROOT:path.join(temp,'project'),VIDEO_OS_TEST_PROJECT_ROOT:path.join(temp,'project'),VIDEO_OS_USER_DATA:path.join(temp,'profile'),
    VIDEO_OS_DATA_DIR:path.join(temp,'data'),OBSIDIAN_VAULT_PATH:path.join(temp,'obsidian'),VIDEO_OS_TEST_OBSIDIAN_VAULT:path.join(temp,'obsidian')};
  delete env.ELECTRON_RUN_AS_NODE;
  const receipt={status:'running',version,platform:process.platform,scope:{actualPackagedApp:true,localDomFixture:true,physicalMouseTested:false,formalAppTouched:false}};
  let app;
  try{
    app=await launchIsolatedElectron({executablePath,env});
    const runtime=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}));
    assert.equal(runtime.version,version);assert.equal(runtime.packaged,true);receipt.runtime=runtime;
    receipt.results=await app.renderer(()=>{
      const tabs=document.querySelector('#platformTabs');
      tabs.style.cssText='flex:none;width:500px;overflow-x:auto;scroll-behavior:auto';
      tabs.replaceChildren();
      const longName='这是一个需要完整显示不能压缩或省略的很长网页标签名称 GPT 项目素材整理';
      const labelChecks=[];
      for(const className of ['platform-tab-wrap closable','platform-tab-wrap closable','platform-tab-wrap pinned']){
        const wrap=document.createElement('span');wrap.className=className;
        const button=document.createElement('button');button.className='platform-tab'+(labelChecks.length===1?' active':'');button.textContent=longName;wrap.append(button);tabs.append(wrap);
        const css=getComputedStyle(button),rect=button.getBoundingClientRect();
        if(button.scrollWidth>button.clientWidth+1 || getComputedStyle(wrap).flexShrink!=='0' || css.textOverflow==='ellipsis' || rect.width<200)throw Error('long tab name compressed');
        labelChecks.push({active:button.classList.contains('active'),pinned:wrap.classList.contains('pinned'),width:rect.width,fullNameVisible:true});
      }
      const fixture=document.createElement('div');fixture.style.cssText='flex:0 0 2400px;height:35px';tabs.append(fixture);
      const reports=[];
      const test=(name,init,delta,cancelled)=>{tabs.scrollLeft=400;const before=tabs.scrollLeft;
        const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:80,...init});fixture.dispatchEvent(e);
        const after=tabs.scrollLeft;if(Math.abs(after-before-delta)>1 || e.defaultPrevented!==cancelled)throw Error(name+JSON.stringify({before,after,cancelled:e.defaultPrevented}));
        reports.push({name,before,after,prevented:e.defaultPrevented});};
      test('pixel-down',{},80,true);test('pixel-up',{deltaY:-80},-80,true);
      test('line-mode',{deltaY:3,deltaMode:1},96,true);test('page-mode',{deltaY:1,deltaMode:2},500,true);
      test('horizontal-pass-through',{deltaX:100,deltaY:10},0,false);
      test('ctrl-zoom-pass-through',{ctrlKey:true},0,false);test('meta-pass-through',{metaKey:true},0,false);test('shift-native-pass-through',{shiftKey:true},0,false);
      tabs.scrollLeft=0;let e=new WheelEvent('wheel',{cancelable:true,deltaY:-100});tabs.dispatchEvent(e);if(tabs.scrollLeft!==0)throw Error('left boundary');
      tabs.scrollLeft=tabs.scrollWidth;const max=tabs.scrollLeft;e=new WheelEvent('wheel',{cancelable:true,deltaY:100});tabs.dispatchEvent(e);if(tabs.scrollLeft!==max)throw Error('right boundary');
      tabs.querySelectorAll('.platform-tab-wrap').forEach(w=>w.remove());fixture.style.flexBasis='100px';tabs.scrollLeft=0;e=new WheelEvent('wheel',{cancelable:true,deltaY:100});tabs.dispatchEvent(e);if(e.defaultPrevented)throw Error('no overflow intercepted');
      return {cases:reports,labelChecks,boundaries:true,noOverflowPassThrough:true};
    });receipt.status='passed';
  }finally{
    if(app){await app.close();assert.notEqual(app.process().exitCode,null);receipt.processExited=true;}
    fs.rmSync(temp,{recursive:true,force:true});receipt.fixtureCleaned=!fs.existsSync(temp);
    fs.writeFileSync(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  }
  console.log('TAB_WHEEL_NATIVE_PASS version='+version+' platform='+process.platform+' cases=11 ownedAppExited=true');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
