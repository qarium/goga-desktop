import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import { CommandExitError } from "../src/host/process";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function fixture() {
  const dir = await mkdtemp("/private/tmp/goga-prune-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  const state = new DesktopStateStore(home, dataDir);
  await state.addProject({ id: "p", name: "Test", path: root });
  let candidates = "orphan\n";
  const command = vi.fn(async (_exe: string, args: string[], cwd: string) => {
    expect(cwd).toBe(root);
    if (args.join(" ") === "history --year 2026 prune --dry-run")
      return { stdout: candidates, stderr: "" };
    if (args.join(" ") === "history --year 2026 prune") {
      await rm(path.join(root, ".goga/history/2026/orphan"), {
        recursive: true,
      });
      return { stdout: "orphan\n", stderr: "" };
    }
    throw Error("Unexpected command " + args.join(" "));
  });
  const host = new HostService({
    home,
    dataDir,
    goga: "/fixture/goga",
    runner: { command, start: vi.fn(), kill: vi.fn() } as any,
  });
  cleanups.push(() => host.dispose());
  const file = async (rel: string, text = "text") => {
    const p = path.join(root, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  };
  await file(".goga/history/2026/orphan/task.md");
  await file(".goga/history/2026/kept/task.md");
  return {
    host,
    root,
    state,
    command,
    file,
    setCandidates: (value: string) => {
      candidates = value;
    },
  };
}
it("previews without deleting, then revalidates and prunes only the approved primary year once", async () => {
  const f = await fixture();
  const preview = await f.host.prepareHistoryPrune("p", "2026");
  expect(preview.status).toBe("ready");
  expect(preview.entries).toEqual(["orphan"]);
  expect(preview.token).toBeTruthy();
  expect(await f.host.listHistoryEntries("p", "2026")).toEqual([
    "kept",
    "orphan",
  ]);
  expect(f.command).toHaveBeenCalledTimes(1);
  const result = await f.host.pruneHistory("p", preview.token!);
  expect(result.status).toBe("ok");
  expect(result.changed).toBe(true);
  expect(f.command.mock.calls.map((c) => c[1])).toEqual([
    ["history", "--year", "2026", "prune", "--dry-run"],
    ["history", "--year", "2026", "prune", "--dry-run"],
    ["history", "--year", "2026", "prune"],
  ]);
  expect(await f.host.listHistoryEntries("p", "2026")).toEqual(["kept"]);
  expect((await f.host.pruneHistory("p", preview.token!)).status).toBe("error");
  expect(f.command).toHaveBeenCalledTimes(3);
});
it("empty preview has no deletion capability", async () => {
  const f = await fixture();
  f.setCandidates("");
  const p = await f.host.prepareHistoryPrune("p", "2026");
  expect(p.entries).toEqual([]);
  expect(p.token).toBeUndefined();
});
it("rejects topic scopes, selected topic, invalid year and unknown project before CLI", async () => {
  const f = await fixture();
  for (const [s, y] of [
    [{ projectId: "p" }, "2026"],
    ["p", "../2026"],
    ["unknown", "2026"],
  ] as any[])
    expect((await f.host.prepareHistoryPrune(s, y)).status).toBe("error");
  (f.host as any).selectedContext = { projectId: "p" };
  expect((await f.host.prepareHistoryPrune("p", "2026")).status).toBe("error");
  expect(f.command).not.toHaveBeenCalled();
});
it.each([
  "candidates",
  "file",
  "year inventory",
  "settings",
  "context",
  "expired",
  "wrong project",
] as const)("refuses stale confirmation: %s", async (kind) => {
  const f = await fixture(),
    p = await f.host.prepareHistoryPrune("p", "2026");
  if (kind === "candidates") f.setCandidates("kept\norphan\n");
  if (kind === "file")
    await f.file(".goga/history/2026/orphan/task.md", "changed");
  if (kind === "year inventory") await f.file(".goga/history/2026/new/task.md");
  if (kind === "settings") {
    const d = await f.state.read("p");
    await f.state.save(
      "p",
      { ...d.value, executable: "/changed/goga" },
      d.version,
    );
  }
  if (kind === "context") (f.host as any).selectedContext = { projectId: "p" };
  if (kind === "expired")
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301000);
  const result = await f.host.pruneHistory(
    kind === "wrong project" ? "other" : "p",
    p.token!,
  );
  expect(result.status).toBe("error");
  expect(f.command.mock.calls.some((c) => c[1].at(-1) === "prune")).toBe(false);
  vi.restoreAllMocks();
});
it.each(["../escape\n", "orphan\norphan\n", "missing\n"])(
  "rejects malformed/unbound dry-run output %s",
  async (output) => {
    const f = await fixture();
    f.setCandidates(output);
    const p = await f.host.prepareHistoryPrune("p", "2026");
    expect(p.status).toBe("error");
    expect(p.token).toBeUndefined();
  },
);
it("rejects symlinked history without CLI", async () => {
  const f = await fixture();
  await rm(path.join(f.root, ".goga/history"), { recursive: true });
  await symlink("/private/tmp", path.join(f.root, ".goga/history"));
  expect((await f.host.prepareHistoryPrune("p", "2026")).status).toBe("error");
  expect(f.command).not.toHaveBeenCalled();
});
it("reports partial mutation failures with bounded diagnostics and requires a fresh preview", async () => {
  const f = await fixture(),
    p = await f.host.prepareHistoryPrune("p", "2026");
  const implementation = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (exe, args, cwd) => {
    if (args.at(-1) === "prune")
      throw new CommandExitError(
        "cleanup failed",
        1,
        "orphan\n",
        "disk failure",
      );
    return implementation(exe, args, cwd);
  });
  const r = await f.host.pruneHistory("p", p.token!);
  expect(r.status).toBe("error");
  expect(r.changed).toBe(true);
  expect(r.log).toContain("disk failure");
  expect((await f.host.pruneHistory("p", p.token!)).changed).toBe(false);
});
it("does not dispatch two mutations for concurrent confirmations", async () => {
  const f = await fixture(),
    p = await f.host.prepareHistoryPrune("p", "2026");
  const r = await Promise.all([
    f.host.pruneHistory("p", p.token!),
    f.host.pruneHistory("p", p.token!),
  ]);
  expect(r.map((v) => v.status).sort()).toEqual(["error", "ok"]);
  expect(
    f.command.mock.calls.filter((c) => c[1].at(-1) === "prune"),
  ).toHaveLength(1);
});
it("redacts configured environment values from CLI errors and logs", async () => {
  const f = await fixture(),
    d = await f.state.read("p");
  await f.state.save(
    "p",
    { ...d.value, env: [{ key: "FIXTURE_SECRET", value: "private-value" }] },
    d.version,
  );
  f.command.mockRejectedValue(
    new CommandExitError(
      "bad private-value",
      1,
      "private-value",
      "https://user:password@example.invalid/?token=secret",
    ),
  );
  const p = await f.host.prepareHistoryPrune("p", "2026");
  expect(p.status).toBe("error");
  expect(p.log).not.toContain("private-value");
  expect(p.log).not.toContain("password");
  expect(p.log).not.toContain("token=secret");
  expect(p.token).toBeUndefined();
});
it("keeps mutation uncertainty when catalog changes after successful deletion", async () => {
  const f = await fixture(),
    p = await f.host.prepareHistoryPrune("p", "2026"),
    impl = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (exe, args, cwd) => {
    const r = await impl(exe, args, cwd);
    if (args.at(-1) === "prune") (f.host as any).catalogEpoch++;
    return r;
  });
  const r = await f.host.pruneHistory("p", p.token!);
  expect(r.changed).toBe(true);
});
