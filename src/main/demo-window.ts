import { t } from "../shared/i18n";
import { clipboard, type BrowserWindow, type IpcMain } from "electron";
import type { HostService } from "../host/service";
import type { Demonstrations } from "../host/demonstrations/runtime";
import { demoCommandSchema, type DemoCommand } from "../shared/demonstrations";
import { createDemoBrowser } from "./demo-browser";
import { registerDemoIPC, copyDemoPageURL } from "./demo-ipc";
import { createDemoSelectionClipboard } from "./demo-selection-clipboard";
import { DemoLifetime } from "./demo-lifetime";
export function createWindowDemonstrations(
  ipc: IpcMain,
  d: {
    window: BrowserWindow;
    shellURL: string;
    runtime: Demonstrations;
    service: HostService;
    openExternal: (url: string) => Promise<void>;
  },
) {
  const { runtime } = d;
  const selectionClipboard = createDemoSelectionClipboard(runtime, (text) =>
    clipboard.writeText(text),
  );
  const life = new DemoLifetime(
    () => runtime.shows(),
    (id) => runtime.execute({ action: "stop", showId: id }),
  );
  const execute = (cmd: DemoCommand, label?: string) =>
    cmd.action === "open" || cmd.action === "stop"
      ? life.admit(() => runtime.execute(cmd, label))
      : runtime.execute(cmd, label);
  const viewer = createDemoBrowser({
    openExternal: d.openExternal,
    nextFrame: (id, tab, after) => runtime.nextFrame(id, tab, after),
    frame: (id) => runtime.frame(id),
    status: async (id) => {
      // A viewer keeps its own show fresh even while Desktop is in another
      // workspace/background. It never polls another show's browser.
      const s = await runtime.showState(id);
      return s
        ? { url: s.url, tabs: s.tabs, activeTabId: s.activeTabId }
        : null;
    },
    control: (showId, op) => {
      if (op.op === "input") {
        const { op: _, tabId, ...input } = op;
        return execute(
          demoCommandSchema.parse({ action: "input", showId, tabId, input }),
        );
      }
      if (op.op === "tab-create")
        return execute({ action: "tab-create", showId });
      if (op.op === "tab-select" || op.op === "tab-close")
        return execute({ action: op.op, showId, tabId: op.tabId });
      if (op.op === "reload") return execute({ action: "reload", showId });
      if (op.op === "navigate")
        return execute({ action: "navigate", showId, url: op.url });
      throw Error(t("native.demoBadCommand"));
    },
  });
  const unregister = registerDemoIPC(ipc, {
    window: d.window,
    shellURL: d.shellURL,
    runtime: {
      state: () => runtime.state(),
      nextFrame: (id, tab, after) => runtime.nextFrame(id, tab, after),
      frame: (id) => runtime.frame(id),
      execute,
    },
    openBrowser: (id) => viewer.open(id),
    copySelection: (id, tabId, requestId) =>
      selectionClipboard.copy(id, tabId, requestId),
    cancelSelectionCopy: (id) => selectionClipboard.cancel(id),
    copyURL: (id, tabId) =>
      copyDemoPageURL(runtime.shows(), id, tabId, (url) =>
        clipboard.writeText(url),
      ),
    withOwner: (scope, open) => d.service.withDemonstrationOwner(scope, open),
  });
  return {
    prepare: () => life.prepare(),
    close: async () => {
      selectionClipboard.close();
      unregister();
      await Promise.all([viewer.close(), runtime.close()]);
    },
  };
}
