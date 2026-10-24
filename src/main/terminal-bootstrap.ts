import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ipcMain, type BrowserWindow } from "electron";
import {
  createTerminalRuntime,
  type TerminalRuntimeOptions,
} from "./terminal-runtime";
import { TerminalViews } from "./terminal-views";
import { registerTerminalIPC } from "./terminal-ipc";
import {
  createTerminalInspector,
  createIsolatedTerminalInspector,
} from "../host/terminal-inspector";
import type { NativeTerminalDriver } from "../host/terminal-native";

function absolute(value: string) {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw Error("Недопустимое расположение компонентов терминала.");
  return value;
}
export function terminalAssets(
  appRoot: string,
  resources: string,
  packaged: boolean,
) {
  absolute(appRoot);
  absolute(resources);
  return {
    preload: path.join(appRoot, "dist-electron/terminal-preload.cjs"),
    url: pathToFileURL(path.join(appRoot, "dist/terminal/index.html")).href,
    inspector: packaged
      ? path.join(resources, "terminal/terminal-inspect")
      : path.join(appRoot, "dist-electron/native/terminal-inspect"),
  };
}
export function lazyTerminalDriver(
  appRoot: string,
  load: (name: string) => any = createRequire(
    path.join(absolute(appRoot), "package.json"),
  ),
): NativeTerminalDriver {
  absolute(appRoot);
  let driver: NativeTerminalDriver | undefined;
  return {
    spawn: (shell, args, options) => {
      if (!driver) {
        const root = path.join(appRoot, "node_modules/node-pty");
        if (load(path.join(root, "package.json")).version !== "1.1.0")
          throw Error("Неподдерживаемая версия системного терминала.");
        const module = load(root);
        if (typeof module.spawn !== "function")
          throw Error("Системный терминал недоступен.");
        // Legacy .on(error) is validated for this exact pinned node-pty version.
        // Never reject a returned live child: ownership transfer belongs to NativeAdapter.
        driver = {
          spawn: (file, argv, settings) => module.spawn(file, argv, settings),
        };
      }
      return driver.spawn(shell, args, options);
    },
  };
}
/** Host bootstrap only. Main must install its unified shutdown handler BEFORE
 * loading the shell document or exposing controls; this factory never starts a PTY.
 */
export function createWindowTerminal(options: {
  window: BrowserWindow;
  shellURL: string;
  home: string;
  appRoot: string;
  resources: string;
  packaged: boolean;
  host: TerminalRuntimeOptions["host"];
  canFocus?: () => boolean;
}) {
  const assets = terminalAssets(
    options.appRoot,
    options.resources,
    options.packaged,
  );
  const retainedInspector = options.packaged
    ? undefined
    : createIsolatedTerminalInspector(assets.inspector);
  const inspector =
    retainedInspector ?? createTerminalInspector(assets.inspector);
  const views = new Set<TerminalViews>();
  const runtime = createTerminalRuntime({
    home: options.home,
    host: options.host,
    driver: lazyTerminalDriver(options.appRoot),
    inspector,
    createView: (lost) => {
      const view = new TerminalViews(options.window, {
        url: assets.url,
        preload: assets.preload,
        state: lost,
        canFocus: options.canFocus,
      });
      views.add(view);
      return view;
    },
  });
  const detach = registerTerminalIPC(ipcMain, {
    window: options.window,
    shellURL: options.shellURL,
    ...runtime,
  });
  return {
    ...runtime,
    disposeAfterExit() {
      if (runtime.sessions.list().some((s) => s.state !== "exited"))
        throw Error("Сначала требуется безопасно завершить сессии терминала.");
      detach();
      for (const view of views) view.dispose();
      views.clear();
      retainedInspector?.dispose();
    },
  };
}
