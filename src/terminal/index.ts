import { terminalConfirmation } from "./confirmation";
import { TerminalScreens, type TerminalScreenSurface } from "./screens";
import {
  terminalScreenCommandSchema,
  type TerminalScreenBridge,
} from "../shared/terminal-screen";
interface Disposable {
  dispose(): void;
}
/** Structural boundary keeps dependency installation/packaging in its explicit plan stage.
 * The isolated native verification supplies actual xterm + FitAddon, not a second parser.
 */
export interface TerminalLibraries {
  Terminal: new (options: Record<string, unknown>) => {
    cols: number;
    rows: number;
    options: { disableStdin?: boolean };
    buffer: { active: { viewportY: number; baseY: number } };
    parser: {
      registerOscHandler(id: number, handler: () => boolean): Disposable;
    };
    open(element: HTMLElement): void;
    loadAddon(addon: any): void;
    write(text: string, callback: () => void): void;
    onData(callback: (text: string) => void): Disposable;
    focus(): void;
    paste(text: string): void;
    resize(cols: number, rows: number): void;
    scrollToLine(line: number): void;
    dispose(): void;
  };
  FitAddon: new () => {
    proposeDimensions(): { cols: number; rows: number } | undefined;
  };
}
export function mountTerminalRenderer(
  root: HTMLElement,
  bridge: TerminalScreenBridge,
  libraries: TerminalLibraries,
): () => void {
  const screens = new TerminalScreens({
    ...bridge,
    create: (grant, options): TerminalScreenSurface => {
      const container = document.createElement("div");
      container.className = "terminal-screen";
      container.style.cssText =
        "position:absolute;inset:0;display:none;overflow:hidden";
      root.append(container);
      const term = new libraries.Terminal({
        ...options,
        cols: 80,
        rows: 24,
        allowProposedApi: false,
        logLevel: "off",
        macOptionIsMeta: true,
        fontFamily: "Menlo, monospace",
        fontSize: 13,
        theme: {
          background: "#090e1a",
          foreground: "#dce5f3",
          cursor: "#16cbb9",
        },
        // The host validates the capability/URL and asks before opening externally.
        linkHandler: {
          activate: (_event: MouseEvent, url: string) => {
            if (shown && enabled && !disposed && !cancelConfirmation)
              bridge.link({ ...grant, url });
          },
        },
      });
      const fit = new libraries.FitAddon();
      term.loadAddon(fit);
      term.open(container);
      const inputStatus = document.createElement("div");
      inputStatus.setAttribute("role", "status");
      inputStatus.textContent = "Только просмотр — ввод недоступен";
      inputStatus.style.cssText =
        "display:none;position:absolute;right:8px;top:8px;background:#162136;color:#a9b8ce;padding:4px 8px;font:12px sans-serif;pointer-events:none;z-index:2";
      container.append(inputStatus);
      const clipboard = term.parser.registerOscHandler(52, () => true);
      let shown = false,
        enabled = true,
        disposed = false;
      let cancelConfirmation: (() => void) | undefined;
      const paste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const tooLarge =
          text.length > 1024 * 1024 ||
          new TextEncoder().encode(text).byteLength > 1024 * 1024;
        if (!/[\r\n]/.test(text) && !tooLarge && !cancelConfirmation) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!shown || !enabled || disposed || cancelConfirmation) return;
        let decided = false;
        const cancel = terminalConfirmation(
          root,
          tooLarge
            ? {
                title: "Вставка недоступна",
                message:
                  "Текст слишком большой: предел вставки — 1 МиБ. Разделите его на части; ничего не отправлено.",
              }
            : {
                title: "Вставить несколько строк?",
                message:
                  "Текст может выполнить команды в текущей сессии. Проверьте его перед вставкой.",
                preview: text,
                confirm: "Вставить",
              },
          (confirmed) => {
            decided = true;
            cancelConfirmation = undefined;
            term.options.disableStdin = !enabled;
            if (confirmed && !tooLarge && shown && enabled && !disposed)
              term.paste(text);
            if (shown && enabled && !disposed) term.focus();
          },
        );
        if (!decided) cancelConfirmation = cancel;
      };
      container.addEventListener("paste", paste, true);
      return {
        write: (text, done) => term.write(text, done),
        onData: (callback) => term.onData(callback),
        inputEnabled: (value) => {
          enabled = value;
          inputStatus.style.display = value ? "none" : "block";
          if (!value) cancelConfirmation?.();
          term.options.disableStdin = !enabled;
        },
        visible: (visible, focus = true) => {
          shown = visible;
          if (!visible) cancelConfirmation?.();
          container.style.display = visible ? "block" : "none";
          if (visible && focus && !cancelConfirmation) term.focus();
        },
        fit: () => {
          if (!shown) return;
          // A newly attached native view can still report its zero-sized viewport.
          // FitAddon clamps that to 2x1, which erases/reflows live output. Wait for
          // the real resize notification instead of changing either xterm or PTY.
          const viewport = root.getBoundingClientRect();
          if (viewport.width <= 16 || viewport.height <= 16) return;
          const measured = fit.proposeDimensions();
          if (
            !measured ||
            !Number.isFinite(measured.cols) ||
            !Number.isFinite(measured.rows)
          )
            return;
          const cols = Math.max(2, Math.min(1000, Math.floor(measured.cols))),
            rows = Math.max(1, Math.min(1000, Math.floor(measured.rows)));
          if (cols !== term.cols || rows !== term.rows) {
            const buffer = term.buffer.active,
              offset = buffer.viewportY,
              scrolled = offset < buffer.baseY;
            term.resize(cols, rows);
            if (scrolled)
              term.scrollToLine(Math.min(offset, term.buffer.active.baseY));
          }
          return { cols, rows };
        },
        dispose: () => {
          disposed = true;
          cancelConfirmation?.();
          clipboard.dispose();
          container.removeEventListener("paste", paste, true);
          term.dispose();
          container.remove();
        },
      };
    },
  });
  const offFrame = bridge.onFrame((value) => screens.receive(value));
  const offCommand = bridge.onCommand((value) => {
    const result = terminalScreenCommandSchema.safeParse(value);
    if (!result.success) return;
    const command = result.data;
    try {
      switch (command.kind) {
        case "grant":
          screens.grant(command.grant);
          break;
        case "select":
          screens.select(command.grant, command.focus, command.interactive);
          break;
        case "exited":
          screens.exited(command.grant);
          break;
        case "lost":
          screens.screenLost(command.grant);
          break;
        case "remove":
          screens.remove(command.grant);
          break;
      }
    } catch {
      if (command.grant) bridge.fault(command.grant);
    }
  });
  const resize = () => screens.fit();
  window.addEventListener("resize", resize);
  bridge.ready();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    offFrame();
    offCommand();
    window.removeEventListener("resize", resize);
    screens.dispose();
  };
}
