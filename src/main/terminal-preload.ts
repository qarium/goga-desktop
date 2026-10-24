import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { TerminalScreenBridge } from "../shared/terminal-screen";
const subscribe = (channel: string, callback: (value: unknown) => void) => {
  const listener = (_event: IpcRendererEvent, value: unknown) =>
    callback(value);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
};
const bridge: TerminalScreenBridge = {
  link: (value) => ipcRenderer.send("terminal-screen:link", value),
  ready: () => ipcRenderer.send("terminal-screen:ready"),
  input: (value) => ipcRenderer.send("terminal-screen:input", value),
  resize: (value) => ipcRenderer.send("terminal-screen:resize", value),
  ack: (value) => ipcRenderer.send("terminal-screen:ack", value),
  fault: (value) => ipcRenderer.send("terminal-screen:fault", value),
  onFrame: (callback) => subscribe("terminal-screen:frame", callback),
  onCommand: (callback) => subscribe("terminal-screen:command", callback),
};
contextBridge.exposeInMainWorld("terminalScreen", bridge);
