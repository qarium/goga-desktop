import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
const cell = (cell: string) => ({
  cell,
  description: "description",
  types: [],
  usages: [],
  dependencies: {},
  children: [],
});
async function setup() {
  const dir = await mkdtemp("/private/tmp/goga-overview-host-");
  await mkdir(dir + "/home");
  await mkdir(dir + "/project");
  const state = new DesktopStateStore(dir + "/home", dir + "/data");
  await state.addProject({ id: "p", name: "Test", path: dir + "/project" });
  const command = vi.fn(async (_exe: string, args: string[]) => ({
    stdout: JSON.stringify(args[0] === "schema" ? [cell("a")] : { a: {} }),
    stderr: "",
  }));
  const host = new HostService({
    home: dir + "/home",
    dataDir: dir + "/data",
    runner: { command, start: vi.fn(), kill: vi.fn() } as any,
  });
  return {
    host,
    dir,
    command,
    cleanup: async () => {
      await host.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it("binds public Goga commands to the registered root and uses confirmed schema membership", async () => {
  const f = await setup();
  try {
    await f.host.readOverviewSchema("p");
    await f.host.readOverviewContract("p", "a");
    expect(f.command.mock.calls.map((c) => c[1])).toEqual([
      ["schema"],
      ["contract", "--", "a"],
    ]);
    await expect(f.host.readOverviewContract("p", "absent")).rejects.toThrow(
      /отсутствует/,
    );
  } finally {
    await f.cleanup();
  }
});
it("does not cache a snapshot which failed final settings verification", async () => {
  const f = await setup();
  try {
    vi.spyOn(f.host as any, "assertSettings").mockRejectedValueOnce(
      Error("settings changed"),
    );
    await expect(f.host.readOverviewSchema("p")).rejects.toThrow(
      "settings changed",
    );
    await f.host.readOverviewContract("p", "a");
    expect(
      f.command.mock.calls.filter((c) => c[1][0] === "schema"),
    ).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});
it("never lets an older schema response replace the latest requested membership", async () => {
  const f = await setup();
  try {
    const finish: ((v: any) => void)[] = [];
    f.command.mockImplementation((_e, args) =>
      args[0] === "schema"
        ? new Promise((r) => finish.push(r))
        : Promise.resolve({ stdout: '{"b":{}}', stderr: "" }),
    );
    const a = f.host.readOverviewSchema("p");
    await vi.waitFor(() => expect(finish.length).toBe(1));
    const b = f.host.readOverviewSchema("p");
    await vi.waitFor(() => expect(finish.length).toBe(2));
    finish[1]({ stdout: JSON.stringify([cell("b")]), stderr: "" });
    await b;
    finish[0]({ stdout: JSON.stringify([cell("a")]), stderr: "" });
    await a;
    await f.host.readOverviewContract("p", "b");
    await expect(f.host.readOverviewContract("p", "a")).rejects.toThrow(
      /отсутствует/,
    );
  } finally {
    await f.cleanup();
  }
});
it("drains an admitted overview write before accepting shutdown and rejects new writes", async () => {
  const f = await setup();
  try {
    let finish!: () => void;
    const suspended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const read = vi
      .spyOn(f.host as any, "overviewRead")
      .mockImplementation(async () => {
        await suspended;
        return null;
      });
    const write = f.host.createOverviewEntry("p", "created", "directory");
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    let prepared = false;
    const closing = f.host.prepareShutdown().then((value) => {
      prepared = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(prepared).toBe(false);
    expect(() => f.host.createOverviewEntry("p", "new", "directory")).toThrow(
      /выходу/,
    );
    finish();
    await write;
    const guard = await closing;
    expect(prepared).toBe(true);
    guard.release();
  } finally {
    await f.cleanup();
  }
});
