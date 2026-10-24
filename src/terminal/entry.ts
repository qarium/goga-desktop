import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { mountTerminalRenderer } from "./index";
import type { TerminalScreenBridge } from "../shared/terminal-screen";

const root = document.getElementById("terminal-root");
const bridge = (window as unknown as { terminalScreen?: TerminalScreenBridge })
  .terminalScreen;
if (!root || !bridge) throw Error("Terminal screen bridge is unavailable.");
mountTerminalRenderer(root, bridge, { Terminal, FitAddon });
