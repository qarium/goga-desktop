// Hidden, disposable renderer fixture. Never uses the app's host service or user state.
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import electron from "electron";
const root = path.resolve("work/project-settings-ui-" + Date.now());
mkdirSync(root, { recursive: true });
const preload = `const {contextBridge}=require('electron');
let settings={value:{executable:'goga',profile:'',env:[{key:'DEMO_HOST',value:'example only',secret:false,runtime:false},{key:'DEMO_SECRET',value:'fake-canary-not-a-token',secret:true,runtime:true}]},version:'v1',profiles:[{name:'careful',source:'home'},{name:'review',source:'project'}]};
let selected=null;const selections=[];const api={listProjects:async()=>[{id:'fixture',name:'prettyplay',path:'/fixture/prettyplay'}],runs:async()=>[{id:'fixture-run',projectId:'fixture',pipeline:'review',topic:'demo-topic',branch:'demo/topic',status:'running',workflow:'review',profile:null,startedAt:'2026-10-17T00:00:00Z'}],onRuns:()=>()=>{},onFocusRun:()=>()=>{},onViewError:()=>()=>{},selectRun:async id=>{selected=id;selections.push(id)},readProjectSettings:async()=>structuredClone(settings),saveProjectSettings:async(id,value,version)=>{if(version!==settings.version)throw Error('conflict');settings={...settings,value,version:'v2'};return structuredClone(settings)},closeRun:async()=>{throw Error('fixture forbids close')},stopRun:async()=>{throw Error('fixture forbids stop')},launch:async()=>{throw Error('fixture forbids launch')},chooseProject:async()=>null};
contextBridge.exposeInMainWorld('goga',api);contextBridge.exposeInMainWorld('fixtureCheck',{state:()=>({settings,selected,selections})});`;
writeFileSync(path.join(root, "preload.cjs"), preload);
const main = `const {app,BrowserWindow}=require('electron');const fs=require('fs');const path=require('path');const assert=require('assert/strict');const root=${JSON.stringify(root)};
app.setPath('userData',path.join(root,'data'));app.setPath('sessionData',path.join(root,'session'));app.setPath('crashDumps',path.join(root,'crashes'));app.setAppLogsPath(path.join(root,'logs'));app.setName('Goga disposable settings fixture');
setTimeout(()=>app.exit(2),45000).unref();
(async()=>{await app.whenReady();app.dock?.hide();const win=new BrowserWindow({show:false,width:1000,height:1000,webPreferences:{preload:path.join(root,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});const wc=win.webContents;const ev=s=>wc.executeJavaScript(s);async function until(s){for(let i=0;i<150;i++){if(await ev(s))return;await new Promise(r=>setTimeout(r,20))}throw Error('fixture timeout')}
await win.loadFile(${JSON.stringify(path.resolve("dist/index.html"))});await until("!!document.querySelector('[role=tab]')");await ev("document.querySelector('[role=tab]').click()");await until("window.fixtureCheck.state().selected==='fixture-run'");await ev("document.querySelector('.project-settings-action').click()");await until("!!document.querySelector('.runtime-switch')");assert.equal(await ev("window.fixtureCheck.state().selected"),null);
await ev("document.querySelector('.runtime-switch').focus()");wc.sendInputEvent({type:'keyDown',keyCode:'Space'});wc.sendInputEvent({type:'keyUp',keyCode:'Space'});await until("document.querySelector('.runtime-switch').checked");await ev("document.querySelector('.project-settings-panel button[type=submit]').click()");await until("window.fixtureCheck.state().settings.version==='v2'");assert.equal(await ev("window.fixtureCheck.state().settings.value.env[0].runtime"),true);assert.equal(await ev("document.querySelector('input[aria-label=\\\"Значение 2\\\"]').type"),'password');
await ev('new Promise(r=>setTimeout(r,250))');
const result={visibleWindow:win.isVisible(),sizes:[],realPipeline:false,keyboardRuntimeToggle:true,saveRoundtrip:true};for(const [width,height] of [[1000,1350],[700,1000]]){win.setSize(width,height);await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');const overflow=await ev("[...document.querySelectorAll('.project-settings-panel,.scroll-area,.project-bar')].some(e=>e.scrollWidth>e.clientWidth+1)");assert.equal(overflow,false);result.sizes.push({width,height,horizontalOverflow:overflow});fs.writeFileSync(path.join(root,'settings-'+width+'.png'),(await wc.capturePage()).toPNG());}
await ev("[...document.querySelectorAll('button')].find(b=>b.textContent==='← Назад').click()");await until("window.fixtureCheck.state().selected==='fixture-run'");assert.equal(await ev("document.querySelector('[role=tab][aria-selected=true]').textContent.includes('review')"),true);result.contextPreserved=true;fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(result,null,2));win.destroy();app.exit(0)})().catch(e=>{console.error(e.message);app.exit(1)});`;
writeFileSync(path.join(root, "main.cjs"), main);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(root, "main.cjs")], {
  env,
  stdio: "inherit",
});
console.log("fixture:", root);
process.exitCode = result.status ?? 1;
