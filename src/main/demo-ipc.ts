import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  demoCommandSchema,
  demoIdSchema,
  demoFrameRequestSchema,
  demoPageRequestSchema,
  type DemoShow,
  type DemoStreamFrame,
  type DemoState,
  type DemoCommand,
} from "../shared/demonstrations";
import type { ScopeRef } from "../shared/context";
import { IPC_SCOPES } from "../shared/operation-scopes";
interface Deps {
  window: Pick<BrowserWindow, "webContents" | "isDestroyed">;
  shellURL: string;
  runtime: {
    state(): Promise<DemoState> | DemoState;
    execute(cmd: DemoCommand, label?: string): Promise<void>;
    nextFrame(
      id: string,
      tabId: string,
      after: string | null,
    ): Promise<DemoStreamFrame | null>;
    frame(id: string): Promise<Uint8Array>;
  };
  openBrowser(id: string): Promise<void>;
  copyURL(id: string, tabId: string): Promise<void>;
  copySelection(id: string, tabId: string, requestId: string): Promise<boolean>;
  cancelSelectionCopy(requestId: string): Promise<void> | void;
  withOwner(
    scope: ScopeRef,
    open: (label: string) => Promise<void>,
  ): Promise<void>;
}
export function registerDemoIPC(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  d: Deps,
) {
  const channels: string[] = [];
  const bind = (
    operation: string,
    n: number,
    fn: (input: unknown) => unknown,
  ) => {
    const name = "demo-" + operation,
      channel = "goga:" + name;
    if (!Object.hasOwn(IPC_SCOPES, name))
      throw Error("Не задана область операции");
    channels.push(channel);
    ipc.handle(channel, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (
        d.window.isDestroyed() ||
        e.sender !== d.window.webContents ||
        !e.senderFrame ||
        e.senderFrame !== e.sender.mainFrame ||
        e.senderFrame.url !== d.shellURL
      )
        throw Error("Доступ к показам запрещён.");
      if (args.length !== n) throw Error("Некорректный запрос демонстрации.");
      return fn(args[0]);
    });
  };
  const showId = (v: unknown) => {
    const r = demoIdSchema.safeParse(v);
    if (!r.success) throw Error("Некорректный показ.");
    return r.data;
  };
  bind("state", 0, () => d.runtime.state());
  bind("execute", 1, (value) => {
    const parsed = demoCommandSchema.safeParse(value);
    if (!parsed.success) throw Error("Некорректные параметры демонстрации.");
    const cmd = parsed.data;
    if (cmd.action === "input" && !cmd.tabId)
      throw Error("Не указана вкладка ввода.");
    return cmd.action === "open"
      ? d.withOwner(cmd.scope, (label) => d.runtime.execute(cmd, label))
      : d.runtime.execute(cmd);
  });
  bind("next-frame", 1, (value) => {
    const request = demoFrameRequestSchema.safeParse(value);
    if (!request.success) throw Error("Некорректный запрос кадра.");
    const { showId, tabId, after } = request.data;
    return d.runtime.nextFrame(showId, tabId, after);
  });
  bind("copy-selection", 1, (value) => {
    const request = demoPageRequestSchema
      .extend({ requestId: demoIdSchema })
      .safeParse(value);
    if (!request.success)
      throw Error("Некорректный запрос копирования выделения.");
    return d.copySelection(
      request.data.showId,
      request.data.tabId,
      request.data.requestId,
    );
  });
  bind("cancel-selection-copy", 1, (value) =>
    d.cancelSelectionCopy(showId(value)),
  );
  bind("copy-url", 1, (value) => {
    const request = demoPageRequestSchema.safeParse(value);
    if (!request.success)
      throw Error("Некорректный запрос копирования адреса.");
    return d.copyURL(request.data.showId, request.data.tabId);
  });
  bind("frame", 1, (value) => d.runtime.frame(showId(value)));
  bind("browser", 1, (value) => d.openBrowser(showId(value)));
  return () => {
    for (const channel of channels) ipc.removeHandler(channel);
  };
}

// Resolve authority at the clipboard boundary, not from an editable renderer URL.
// No await between selection checks and issuing the write: another page cannot
// replace the captured destination while the copy is being admitted.
export async function copyDemoPageURL(
  shows: readonly DemoShow[],
  showId: string,
  tabId: string,
  writeText: (url: string) => Promise<void>,
): Promise<void> {
  const show = shows.find((s) => s.showId === showId);
  if (
    !show ||
    show.activeTabId !== tabId ||
    !show.tabs?.some((t) => t.tabId === tabId)
  )
    throw Error("Вкладка показа закрыта или заменена.");
  if (!show.url || show.url.length > 8192 || /[\x00-\x20\x7f]/.test(show.url))
    throw Error("У страницы нет адреса для копирования.");
  let url: URL;
  try {
    url = new URL(show.url);
  } catch {
    throw Error("У страницы нет адреса для копирования.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Этот адрес страницы нельзя скопировать.");
  try {
    await writeText(url.href);
  } catch {
    throw Error("Не удалось скопировать адрес страницы. Повторите попытку.");
  }
}
