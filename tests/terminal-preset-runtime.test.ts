import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createTerminalRuntime } from "../src/main/terminal-runtime";
import { createIsolatedTerminalInspector } from "../src/host/terminal-inspector";
import {
  prepareTerminalEnvironment,
  type TerminalSystem,
} from "../src/host/terminal-environment";
import type {
  NativeTerminalDriver,
  NativeTerminal,
} from "../src/host/terminal-native";
import type { TerminalTransportView } from "../src/host/terminal-transport";
import type { TerminalSessionView } from "../src/host/terminal-sessions";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext } from "../src/shared/terminal";

async function wait(condition: () => boolean, label: string) {
  const end = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > end) throw Error("Terminal runtime test: " + label);
    await new Promise((r) => setTimeout(r, 15));
  }
}
function content(p: string) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
const topic = {
  projectId: "demo",
  year: "2026",
  topic: "topic",
  branch: "topic",
  contextId: "ctx-" + "a".repeat(64),
  revision: randomUUID(),
};
function owner(s: ScopeRef): TerminalContext {
  if (typeof s === "string") return { kind: "primary", projectId: s };
  const { revision, ...data } = s;
  return { kind: "topic", ...data };
}

// Runtime composition smoke; no Electron/keychain/agent/user repository. Native
// binary + JS are the real pinned dependency. npm's distributed prebuild can
// lack +x on its helper; set permissions on a PRIVATE copy, never node_modules.
it("runs only explicit presets, isolates project/topic env and restores tab snapshots after refresh and Desktop restart", async () => {
  const dir = mkdtempSync("/private/tmp/goga-runtime-env-");
  const home = join(dir, "home"),
    primary = join(dir, "primary"),
    clone = join(dir, "topic");
  for (const p of [home, primary, clone]) mkdirSync(p);
  writeFileSync(join(home, ".zshenv"), "unsetopt GLOBAL_RCS\n");
  writeFileSync(join(home, ".zshrc"), "PROMPT='TEST> '\n");
  const bin = join(dir, "inspect");
  const sysenv = {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: dir,
  };
  execFileSync(
    "/usr/bin/clang",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      resolve("src/native/terminal-inspect.c"),
      "-o",
      bin,
    ],
    { env: sysenv, timeout: 15000 },
  );
  const inspector = createIsolatedTerminalInspector(bin);
  const src = resolve("node_modules/node-pty"),
    pkg = join(dir, "pty"),
    dst = join(pkg, "build/Release");
  mkdirSync(dst, { recursive: true });
  cpSync(join(src, "lib"), join(pkg, "lib"), { recursive: true });
  for (const name of ["pty.node", "spawn-helper"]) {
    const prebuilt = join(
      src,
      "prebuilds",
      process.platform + "-" + process.arch,
      name,
    );
    cpSync(
      existsSync(prebuilt) ? prebuilt : join(src, "build/Release", name),
      join(dst, name),
    );
  }
  chmodSync(join(dst, "spawn-helper"), 0o700);
  const realDriver: NativeTerminalDriver = createRequire(import.meta.url)(
    join(pkg, "lib/index.js"),
  );
  const launched: NativeTerminal[] = [];
  const driver: NativeTerminalDriver = {
    spawn(...args) {
      const n = realDriver.spawn(...args);
      launched.push(n);
      return n;
    },
  };
  const view: TerminalTransportView = {
    isLost: false,
    whenReady: async () => {},
    attach(ref) {
      return { ...ref, capability: randomUUID() };
    },
    output() {
      return true;
    },
    status() {
      return { pendingBytes: 0, paused: false, state: "live" };
    },
    exited() {},
    fail() {},
    remove() {},
    show() {},
    hide() {},
    dispose() {},
  };
  const options = {
    home,
    driver,
    inspector,
    createView: () => view,
    presetCrypto: {
      seal(s: string) {
        return Buffer.from(s).toString("base64");
      },
      open(s: string) {
        return Buffer.from(s, "base64").toString("utf8");
      },
    },
    host: {
      resolveTerminalOwner: async (s: ScopeRef) => owner(s),
      acquireTerminalContext: async (
        s: ScopeRef,
        requested: TerminalSystem = {},
      ) => {
        const context = owner(s);
        const launch = await prepareTerminalEnvironment(
          context,
          async () => ({
            context,
            root: context.kind === "primary" ? primary : clone,
            env: [
              { key: "PORT", value: "3000", secret: false, runtime: false },
            ],
          }),
          {
            accountShell: () => "/bin/zsh",
            inherited: sysenv,
            presetEnv: requested.presetEnv,
          },
        );
        return { launch, release: () => launch.dispose?.() };
      },
    },
  };
  type Runtime = ReturnType<typeof createTerminalRuntime>;
  const running: Runtime[] = [];
  const openRuntime = () => {
    const r = createTerminalRuntime(options);
    running.push(r);
    return r;
  };
  const probe = async (
    r: Runtime,
    v: TerminalSessionView,
    key: string,
    expected: string,
  ) => {
    r.sessions.write(
      { sessionId: v.sessionId, generation: v.generation },
      `printf '%s|%s' "$PORT" "$PWD" > "$HOME/${key}"\r`,
    );
    await wait(() => content(join(home, key)) === expected, key);
  };
  const stamp = 'printf "%s|%s\\n" "$PORT" "$PWD" >> "$HOME/executions"';
  const count = () =>
    content(join(home, "executions")).trimEnd().split("\n").filter(Boolean);
  try {
    const r = openRuntime();
    const st = await r.catalog.read("demo");
    const normal = (
      await r.catalog.change({
        kind: "initialize",
        revision: st.revision,
        scope: "demo",
      })
    ).tabs[0];
    const normalRun = await r.sessions.open(normal, "demo");
    await probe(r, normalRun, "normal", "3000|" + primary);
    let preset = await r.presetStore!.save({
      name: "Dev",
      command: stamp,
      env: [{ key: "PORT", value: "4100" }],
    });
    const start = async (s: ScopeRef) => {
      const revision = (await r.catalog.read(s)).revision;
      const snapshot = await r.catalog.change({
        kind: "create-from-preset",
        revision,
        scope: s,
        actionId: randomUUID(),
        presetId: preset.id,
        presetRevision: preset.revision,
      });
      const tab = snapshot.tabs.find((t) => t.id === snapshot.selectedId)!;
      const session = await r.sessions.open(tab, s);
      return { tab, session };
    };
    const a = await start("demo");
    await wait(() => count().length === 1, "project preset");
    const b = await r.presetStore!.save(
      { name: "Dev", command: stamp, env: [{ key: "PORT", value: "4200" }] },
      preset.id,
      preset.revision,
    );
    preset = b;
    const other = await start(topic);
    await wait(() => count().length === 2, "topic preset");
    expect(count()).toEqual(["4100|" + primary, "4200|" + clone]);
    await r.presetStore!.remove(preset.id, preset.revision);
    await probe(r, a.session, "original-after-delete", "4100|" + primary);
    await probe(r, other.session, "topic-after-delete", "4200|" + clone);
    // Leave the old shell voluntarily before the real refresh/replace protocol.
    // No OS process besides a synthetic test shell is ever a shutdown target.
    r.sessions.write(
      { sessionId: a.session.sessionId, generation: a.session.generation },
      "exit\r",
    );
    await wait(
      () =>
        r.sessions
          .list()
          .some(
            (v) =>
              v.generation === a.session.generation && v.state === "exited",
          ),
      "exit before refresh",
    );
    const before = r.sessions.prepareClose({
      kind: "refresh",
      ref: { sessionId: a.session.sessionId, generation: a.session.generation },
      scope: "demo",
    });
    expect((await r.sessions.confirmClose(before.token, true)).status).toBe(
      "success",
    );
    const fresh = await r.sessions.open(a.tab, "demo");
    expect(fresh.generation).not.toBe(a.session.generation);
    await probe(r, fresh, "refreshed", "4100|" + primary);
    for (const s of r.sessions.list().filter((s) => s.state === "running"))
      r.sessions.write(
        { sessionId: s.sessionId, generation: s.generation },
        "exit\r",
      );
    await wait(
      () => r.sessions.list().every((v) => v.state === "exited"),
      "stop original runtime",
    );
    const next = openRuntime();
    expect(next.sessions.list()).toEqual([]);
    const t = (await next.catalog.read(topic)).tabs.find(
      (t) => t.id === other.tab.id,
    )!;
    const restored = await next.sessions.open(t, topic);
    await probe(next, restored, "restored", "4200|" + clone);
    expect(count()).toEqual(["4100|" + primary, "4200|" + clone]);
    expect(launched).toHaveLength(5);
  } finally {
    // On failed assertions, only exit shells spawned by this isolated test.
    for (const r of running)
      for (const v of r.sessions.list().filter((s) => s.state === "running")) {
        try {
          r.sessions.write(
            { sessionId: v.sessionId, generation: v.generation },
            "exit\r",
          );
        } catch {}
      }
    try {
      await wait(
        () =>
          running.every((r) =>
            r.sessions.list().every((v) => v.state === "exited"),
          ),
        "test teardown",
      );
    } finally {
      inspector.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 40_000);
