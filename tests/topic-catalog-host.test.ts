import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import type { Runner } from "../src/host/process";
import { withReadScope } from "../src/host/read-scope";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const entry = (
  topic = "feature-a",
  branch = "feature/a",
  current = true,
  remote = false,
) => ({
  topic,
  branch,
  current,
  remote,
  statuses: ["todo"],
  todo: "heavy task",
  divergence: "heavy divergence",
  hosts: [branch, "main"],
});
async function fixture() {
  const dir = await mkdtemp("/private/tmp/goga-fast-catalog-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  await mkdir(repo);
  await mkdir(path.join(dir, "home"));
  let raw = JSON.stringify([
    entry(),
    entry(),
    entry("remote", "origin/remote", false, true),
  ]);
  let during: (() => Promise<void>) | undefined;
  const command = vi.fn(async (exe: string, args: string[], cwd: string) => {
    if (exe === "git" && args.join(" ") === "rev-parse --show-toplevel")
      return { stdout: repo, stderr: "" };
    if (exe === "mock-goga") {
      await during?.();
      return { stdout: raw, stderr: "" };
    }
    throw Error(
      `Unexpected expensive command: ${exe} ${args.join(" ")} in ${cwd}`,
    );
  });
  const runner = {
    command,
    start: vi.fn(),
    kill: vi.fn(),
  } as unknown as Runner;
  const service = new HostService({
    home: path.join(dir, "home"),
    dataDir: path.join(dir, "data"),
    goga: "mock-goga",
    runner,
  });
  cleanup.push(() => service.dispose());
  const project = await service.addProject(repo);
  command.mockClear();
  const internals = service as any;
  const reconcile = vi
    .spyOn(internals.clones, "reconcile")
    .mockRejectedValue(Error("must not reconcile clones"));
  const resolve = vi
    .spyOn(internals.clones, "resolve")
    .mockRejectedValue(Error("must not resolve clones"));
  const fingerprint = vi
    .spyOn(internals, "fingerprint")
    .mockRejectedValue(Error("must not hash project"));
  return {
    service,
    project,
    repo,
    dir,
    command,
    reconcile,
    resolve,
    fingerprint,
    internals,
    read: () => service.readTopicCatalog(project.id, "2026"),
    raw: (value: string) => {
      raw = value;
    },
    during: (value: () => Promise<void>) => {
      during = value;
    },
  };
}
it("reads exactly one installed primary board, strips heavy fields and deduplicates local logical targets without any Git/state/clone traversal", async () => {
  const f = await fixture();
  expect(await f.read()).toEqual({
    projectId: f.project.id,
    year: "2026",
    entries: [{ topic: "feature-a", branch: "feature/a", remote: false }],
    currentTopic: { topic: "feature-a", branch: "feature/a", remote: false },
  });
  expect(f.command).toHaveBeenCalledExactlyOnceWith(
    "mock-goga",
    ["topics", "--year", "2026", "board", "--json"],
    f.repo,
    expect.any(Object),
  );
  expect(f.reconcile).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
  expect(f.fingerprint).not.toHaveBeenCalled();
});
it("does not treat hosted history or remote rows as the current local topic", async () => {
  const f = await fixture();
  f.raw(
    JSON.stringify([
      entry("hosted", "main"),
      entry("remote", "origin/remote", true, true),
    ]),
  );
  expect((await f.read()).currentTopic).toBeNull();
});
it.each([
  "not JSON",
  "{}",
  JSON.stringify([{ ...entry(), remote: "false" }]),
  JSON.stringify([{ ...entry(), statuses: [42] }]),
  JSON.stringify([{ ...entry(), branch: "--bad" }]),
])("fails closed for malformed catalog %s", async (raw) => {
  const f = await fixture();
  f.raw(raw);
  await expect(f.read()).rejects.toThrow(/JSON|каталог/i);
  expect(f.command).toHaveBeenCalledTimes(1);
});
it("rejects unknown project, context-shaped scope and invalid year before executing commands", async () => {
  const f = await fixture();
  await expect(f.service.readTopicCatalog("foreign", "2026")).rejects.toThrow(
    /проект/i,
  );
  await expect(
    f.service.readTopicCatalog({ projectId: f.project.id } as any, "2026"),
  ).rejects.toThrow(/проект|контекст/i);
  for (const year of ["26", "../2026", "2026/feature"])
    await expect(
      f.service.readTopicCatalog(f.project.id, year),
    ).rejects.toThrow();
  expect(f.command).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});
it("does not inherit a clone binding through the primary-only catalog entry point", async () => {
  const f = await fixture();
  await expect(
    f.internals.context.run(
      { projectId: f.project.id, binding: { contextId: "foreign" } },
      f.read,
    ),
  ).rejects.toThrow(/проект|контекст|основн/i);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.resolve).not.toHaveBeenCalled();
});
it("sanitizes command failure and never retries into full board", async () => {
  const f = await fixture();
  f.during(async () => {
    throw Error("SECRET stderr");
  });
  await expect(f.read()).rejects.toThrow(/Goga/);
  await expect(f.read()).rejects.not.toThrow(/SECRET/);
  expect(f.command).toHaveBeenCalledTimes(2);
  expect(f.reconcile).not.toHaveBeenCalled();
});
it("rejects cancellation before dispatch and cancellation after a non-cooperative transport resolves", async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(withReadScope(abort.signal, f.read)).rejects.toThrow(
    /отменено/i,
  );
  expect(f.command).not.toHaveBeenCalled();
  const active = new AbortController();
  f.during(async () => {
    active.abort();
  });
  await expect(withReadScope(active.signal, f.read)).rejects.toThrow(
    /отменено/i,
  );
  expect(f.command).toHaveBeenCalledTimes(1);
});
it("rejects results after catalog epoch changes", async () => {
  const f = await fixture();
  f.during(async () => {
    f.internals.catalogEpoch++;
  });
  await expect(f.read()).rejects.toThrow(/каталог|устарел|изменил/i);
});
it("rejects results after settings change without hashing the working tree", async () => {
  const f = await fixture();
  f.during(async () => {
    const doc = await f.internals.state.read(f.project.id);
    await f.internals.state.save(
      f.project.id,
      { ...doc.value, executable: "changed-goga" },
      doc.version,
    );
  });
  await expect(f.read()).rejects.toThrow(/настройки.*изменил/i);
  expect(f.fingerprint).not.toHaveBeenCalled();
});
it("rejects a primary path replaced by a symlink while reading", async () => {
  const f = await fixture();
  f.during(async () => {
    const foreign = path.join(f.dir, "foreign");
    await mkdir(foreign);
    await rm(f.repo, { recursive: true });
    await symlink(foreign, f.repo);
  });
  await expect(f.read()).rejects.toThrow(/путь|ссыл|symlink/i);
});
it("does not dispatch Goga when cancellation arrives while settings are validated", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const validate = f.internals.assertSettings.bind(f.internals);
  vi.spyOn(f.internals, "assertSettings").mockImplementation(
    async (id: unknown) => {
      await validate(id);
      abort.abort();
    },
  );
  await expect(withReadScope(abort.signal, f.read)).rejects.toThrow(
    /отменено/i,
  );
  expect(f.command).not.toHaveBeenCalled();
});
