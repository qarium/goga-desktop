import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createEmbeddedControl } from "./embedded-control.cjs";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createPipeTarget } from "./transport.cjs";
import { createPageDisplay } from "./display";

import { startPage } from "./start-page.cjs";
async function browserPath(explicit?: string) {
  const paths = explicit
    ? [explicit]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
      : process.platform === "win32"
        ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
            .filter((s): s is string => !!s)
            .flatMap((p) => [
              join(p, "Google/Chrome/Application/chrome.exe"),
              join(p, "Microsoft/Edge/Application/msedge.exe"),
            ])
        : [
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/google-chrome",
            "/opt/google/chrome/chrome",
          ];
  for (const p of paths) {
    if (isAbsolute(p))
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        /* next installed browser */
      }
  }
  throw new Error("Для демонстрации установите Google Chrome или Chromium.");
}
async function within<T>(
  operation: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(onTimeout());
          } catch (e) {
            reject(e);
          }
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function launchBrowser(
  explicit: string | undefined,
  onExit: () => void,
  signal: AbortSignal,
  own: (close: () => Promise<void>) => void,
) {
  return launch(false, explicit, onExit, signal, own);
}
export async function launchEmbeddedBrowser(
  onExit: () => void,
  signal: AbortSignal,
  own: (close: () => Promise<void>) => void,
) {
  return launch(true, undefined, onExit, signal, own);
}
async function launch(
  embedded: boolean,
  explicit: string | undefined,
  onExit: () => void,
  signal: AbortSignal,
  own: (close: () => Promise<void>) => void,
) {
  signal.throwIfAborted();
  if (embedded && !process.versions.electron)
    throw Error("Встроенный браузер доступен только в Desktop.");
  const path = embedded ? process.execPath : await browserPath(explicit);
  // Resolve Electron only inside its live main process, never in Node tests.
  const helperArgs = embedded
    ? [
        ...(process.defaultApp
          ? [
              createRequire(join(process.cwd(), "host.cjs"))(
                "electron",
              ).app.getAppPath() as string,
            ]
          : []),
        "--goga-demonstration-helper",
      ]
    : [];
  const home = await mkdtemp(join(tmpdir(), "goga-demonstration-")).catch(
    () => {
      throw Error("Не удалось создать временный профиль демонстрации.");
    },
  );
  let pageLost = false;
  let proc: ChildProcess | undefined,
    ended = false,
    closing = false;
  let wake!: () => void;
  const exiting = new Promise<void>((resolve) => (wake = resolve));
  let display: Awaited<ReturnType<typeof createPageDisplay>> | undefined;
  let cleanup: Promise<void> | undefined;
  function close(): Promise<void> {
    closing = true;
    return (cleanup ??= (async () => {
      const releases = Promise.allSettled([display?.close()]);
      if (proc) {
        for (const [signal, ms] of [
          ["SIGTERM", 1000],
          ["SIGKILL", 2000],
        ] as const) {
          if (ended) break;
          try {
            if (proc.kill(signal)) await within(exiting, ms, () => {});
          } catch {
            /* retry with SIGKILL below */
          }
        }
        if (!ended)
          throw Error(
            "Не удалось завершить браузер демонстрации. Повторите закрытие.",
          );
      }
      await releases;
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 120,
      }).catch(() => {
        throw Error(
          "Не удалось удалить временный профиль демонстрации. Повторите закрытие.",
        );
      });
    })().catch((error) => {
      cleanup = undefined;
      throw error;
    }));
  }
  // Register cleanup before any further fallible setup. Even failed startup
  // retains a host-owned cleanup handle if killing or deleting fails.
  own(close);
  const interrupt = () => {
    if (proc) void close().catch(() => {});
  };
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    signal.throwIfAborted();
    const profile = join(home, "profile"),
      temp = join(home, "tmp");
    await mkdir(temp, { mode: 0o700 }).catch(() => {
      throw Error("Не удалось подготовить временный профиль демонстрации.");
    });
    // Do not hand inherited terminal/project secrets or the user's profile to
    // a browser controlled over CDP. No debugging socket is opened by Chrome.
    const env: NodeJS.ProcessEnv = {
      HOME: home,
      CFFIXED_USER_HOME: home,
      USERPROFILE: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      LANG: "en_US.UTF-8",
    };
    if (process.platform === "win32") {
      env.SystemRoot = process.env.SystemRoot;
      env.LOCALAPPDATA = home;
      env.APPDATA = home;
    }
    signal.throwIfAborted();
    proc = spawn(
      path,
      [
        "--user-data-dir=" + profile,
        "--remote-debugging-pipe",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-breakpad",
        "--password-store=basic",
        "--use-mock-keychain",
        "--window-size=1100,665",
        ...(embedded ? [] : ["--headless=new"]),
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        ...(embedded ? helperArgs : [startPage]),
      ],
      {
        stdio: [
          embedded ? "pipe" : "ignore",
          embedded ? "pipe" : "ignore",
          "ignore",
          "pipe",
          "pipe",
        ],
        cwd: home,
        env,
        windowsHide: true,
      },
    );
    const end = () => {
      if (!ended) {
        ended = true;
        wake();
        onExit();
      }
    };
    proc.once("exit", end);
    // A failed kill emits "error" too. Only a failed spawn (no PID) is
    // confirmation that no child exists; otherwise await actual process exit.
    proc.on("error", () => {
      if (proc?.pid === undefined) end();
    });
    const control = embedded ? createEmbeddedControl(proc) : undefined;
    const pipe = createPipeTarget(
      proc,
      () => {
        if (!closing && !ended) onExit();
      },
      control,
    );
    // The host owns download policy. Never allow a controlled browser to write
    // downloads into the real Downloads directory or a client-selected path.
    const selected = await within(
      (async () => {
        await pipe.command("Browser.setDownloadBehavior", { behavior: "deny" });
        await pipe.command("Browser.getVersion");
        while (!ended && !closing) {
          const { targetInfos } = await pipe.command("Target.getTargets");
          const page = targetInfos.find(
            (p) => p.type === "page" && p.url.startsWith("data:text/html"),
          );
          if (page) {
            display = await createPageDisplay(pipe, page.targetId, () => {
              // The display replaces lost tabs itself. Only an unrecoverable
              // browser/display failure revokes this whole show's ownership.
              pageLost = true;
              if (!closing && !ended) onExit();
            });
            return display;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        throw Error("Браузер демонстрации закрыт.");
      })(),
      12000,
      () => {
        throw Error("Браузер не ответил при открытии.");
      },
    );
    return {
      pipe,
      view: selected.view,
      navigation: selected.navigation,
      alive: () => !ended && !pageLost,
      reload: selected.reload,
      refreshTabs: selected.refreshTabs,
      tabSnapshot: selected.tabSnapshot,
      createTab: selected.createTab,
      selectTab: selected.selectTab,
      closeTab: selected.closeTab,
      close,
    };
  } finally {
    signal.removeEventListener("abort", interrupt);
  }
}
export type DemoBrowser = Awaited<ReturnType<typeof launchBrowser>>;
