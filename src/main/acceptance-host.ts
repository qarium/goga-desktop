/**
 * Side-effect-free production exports for isolated packaged acceptance.
 * This is not an application entry: it never creates a user window or chooses HOME.
 */
export { HostService } from "../host/service";
export { SettingsStore } from "../host/settings";
export { NodeRunner } from "../host/process";
export { RunRecoveryManager } from "../host/run-recovery";
export { registerIPC } from "./ipc";
export { worktreeContextRef } from "../shared/worktrees";

export { TopicPopup } from "./topic-popup";
