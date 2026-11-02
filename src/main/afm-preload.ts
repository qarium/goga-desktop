import { initializeAFM } from "./afm-preferences";
import { selectAFMStage } from "./afm-stage-navigation";
import { ipcRenderer } from "electron";
// Only main supplies this argument. Never expose process, require or IPC to AFM.
const prefix = "--goga-afm-origin=";
const origin =
  process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length) ?? "";
initializeAFM(window, origin, process.isMainFrame);
if(process.isMainFrame&&origin&&window.location.origin===origin){
  const commands=new Map<string,AbortController>();
  ipcRenderer.on("goga:afm-cancel-stage",(_event,requestId:unknown)=>{if(typeof requestId==="string")commands.get(requestId)?.abort();});
  ipcRenderer.on("goga:afm-select-stage",(_event,command:unknown)=>{
    if(!command||typeof command!=="object"||window.location.origin!==origin)return;
    const {requestId,stageId}=command as {requestId?:unknown;stageId?:unknown};
    if(typeof requestId!=="string"||!/^[a-f0-9-]{36}$/.test(requestId)||typeof stageId!=="string"||commands.has(requestId)||commands.size>=8)return;
    const controller=new AbortController();commands.set(requestId,controller);
    void selectAFMStage(document,stageId,2000,controller.signal).then(selected=>{
      commands.delete(requestId);
      if(window.location.origin===origin)ipcRenderer.send("goga:afm-stage-selected",{requestId,stageId,selected});
    });
  });
}
