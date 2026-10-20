import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  rename,
  symlink,
  link,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
import { saveProjectDocument } from "../src/host/project-documents";
const dirs: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
const target = (name = "shared") => ({ kind: "profile" as const, name });
const source = (name = "shared") => ({
  scope: "project" as const,
  projectId: "p",
  target: target(name),
});
async function setup() {
  const dir = await mkdtemp("/private/tmp/goga-project-profiles-");
  dirs.push(dir);
  const root = path.join(dir, "p"),
    other = path.join(dir, "q"),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "data");
  for (const p of [root, other, home, path.join(dir, "trash")]) await mkdir(p);
  const state = new DesktopStateStore(home, dataDir);
  for (const [id, p] of [
    ["p", root],
    ["q", other],
  ])
    await state.addProject({ id, name: id, path: p });
  const trash = vi.fn(async (file: string) => {
    await rename(file, path.join(dir, "trash", path.basename(file)));
  });
  const runner = {
    command: vi.fn(async (exe: string, args: string[]) => ({
      stdout:
        exe === "git"
          ? args.includes("--git-common-dir")
            ? root
            : "main\n"
          : args.includes("--list")
            ? "* build\n"
            : args.includes("board")
              ? "[]"
              : "* stage:\n  title: Stage\n",
      stderr: "",
    })),
    start: vi.fn(() => {
      throw Error("No real launch");
    }),
    kill: vi.fn(),
  };
  const host = new HostService({
    home,
    dataDir,
    runner,
    goga: "fixture",
    trashItem: trash,
  });
  services.push(host);
  async function file(base: string, name: string, text = "value: saved\n") {
    const p = path.join(base, ".goga/profiles", name);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, text);
    return p;
  }
  return { root, other, home, dir, host, state, trash, runner, file };
}
it("absent project profile reads/list do not create directories; explicit save preserves raw text and isolates home/other", async () => {
  const f = await setup();
  await f.file(f.home, "shared.yml", "from: home\n");
  await f.file(f.other, "shared.yml", "from: other\n");
  expect(await f.host.listProjectProfiles("p")).toEqual([]);
  expect(await f.host.readProjectDocument("p", target())).toMatchObject({
    exists: false,
    version: "missing",
    relativePath: ".goga/profiles/shared.yml",
  });
  expect(await readdir(f.root)).toEqual([]);
  const text = '\ufeff# comment 🙂\r\nunknown: {nested: [1, "yes"]}\r\n';
  await f.host.saveProjectDocument("p", target(), text, "missing");
  expect(
    await readFile(path.join(f.root, ".goga/profiles/shared.yml"), "utf8"),
  ).toBe(text);
  expect(
    await readFile(path.join(f.home, ".goga/profiles/shared.yml"), "utf8"),
  ).toBe("from: home\n");
  expect(
    await readFile(path.join(f.other, ".goga/profiles/shared.yml"), "utf8"),
  ).toBe("from: other\n");
  expect(await f.host.listProjectProfiles("p")).toEqual([
    { name: "shared", path: ".goga/profiles/shared.yml", editable: true },
  ]);
  expect((await f.host.readProjectSettings("p")).value.profile).toBe("");
});
it.each([
  "",
  "a: [",
  "- sequence",
  "scalar",
  "a: 1\na: 2",
  "---\na: 1\n---\nb: 2",
  "{% if x %}\na: 1\n{% endif %}",
  "value: .nan",
  "value: 2026-01-01",
])(
  "invalid profile rejected at direct save boundary before mkdir: %s",
  async (text) => {
    const f = await setup();
    await expect(
      saveProjectDocument(f.root, target(), text, "missing"),
    ).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  },
);
it("invalid existing YAML stays listed and readable, then repair requires matching version", async () => {
  const f = await setup();
  const p = await f.file(f.root, "shared.yml", "broken: [\n");
  expect((await f.host.listProjectProfiles("p"))[0].editable).toBe(true);
  const d = await f.host.readProjectDocument("p", target());
  expect(d.text).toBe("broken: [\n");
  await expect(
    f.host.saveProjectDocument("p", target(), "bad: [", d.version),
  ).rejects.toThrow();
  expect(await readFile(p, "utf8")).toBe(d.text);
  await f.host.saveProjectDocument("p", target(), "fixed: true\n", d.version);
  await expect(
    f.host.saveProjectDocument("p", target(), "overwrite: true\n", d.version),
  ).rejects.toThrow(/измен/);
});
it.each([
  "../x",
  "/tmp/x",
  "a/b",
  "a\\b",
  "bad name",
  "-bad",
  "é",
  "a".repeat(181),
])("rejects invalid profile name %s", async (name) => {
  const f = await setup();
  await expect(f.host.readProjectDocument("p", target(name))).rejects.toThrow();
  await expect(
    f.host.saveProjectDocument("p", target(name), "{}", "missing"),
  ).rejects.toThrow();
  expect(await readdir(f.root)).toEqual([]);
});
it("rejects unknown project, case collision, symlink and hardlink without touching source", async () => {
  const f = await setup();
  await expect(f.host.listProjectProfiles(f.root)).rejects.toThrow(/проект/);
  const p = await f.file(f.root, "Shared.yml");
  await expect(
    f.host.saveProjectDocument("p", target(), "{}", "missing"),
  ).rejects.toThrow();
  await symlink(p, path.join(f.root, ".goga/profiles/alias.yml"));
  await link(p, path.join(f.root, ".goga/profiles/linked.yml"));
  for (const name of ["alias", "linked"]) {
    await expect(
      f.host.readProjectDocument("p", target(name)),
    ).rejects.toThrow();
    await expect(
      f.host.prepareDocumentDeletion(source(name)),
    ).rejects.toThrow();
  }
  expect(await readFile(p, "utf8")).toBe("value: saved\n");
  expect(
    (await f.host.listProjectProfiles("p")).filter((x) => !x.editable),
  ).toHaveLength(3);
});
it("rejects symlinked ancestor and concurrent occupied name", async () => {
  const f = await setup();
  await mkdir(path.join(f.root, ".goga"));
  await symlink(f.other, path.join(f.root, ".goga/profiles"));
  await expect(f.host.listProjectProfiles("p")).rejects.toThrow();
  await expect(
    f.host.saveProjectDocument("p", target(), "{}", "missing"),
  ).rejects.toThrow();
  expect(await readdir(f.other)).toEqual([]);
});
it("project wins even with invalid YAML; deletion warns of home fallback and leaves saved default unchanged", async () => {
  const f = await setup();
  const global = await f.file(f.home, "shared.yml", "from: home\n");
  await f.file(f.root, "shared.yml", "broken: [");
  const settings = await f.host.readProjectSettings("p");
  expect(settings.profiles).toEqual([{ name: "shared", source: "project" }]);
  await f.host.saveProjectSettings(
    "p",
    { ...settings.value, profile: "shared" },
    settings.version,
  );
  const ticket = await f.host.prepareDocumentDeletion(source());
  expect(ticket.profileFallback).toBe(true);
  expect(await f.host.deleteDocument(ticket.token)).toEqual({
    status: "trashed",
  });
  expect((await f.host.readProjectSettings("p")).profiles).toEqual([
    { name: "shared", source: "home" },
  ]);
  expect((await f.host.readProjectSettings("p")).value.profile).toBe("shared");
  expect(await readFile(global, "utf8")).toBe("from: home\n");
});
it("no fallback retains missing default; failed trash preserves bytes and stale ticket cannot delete", async () => {
  const f = await setup();
  const p = await f.file(f.root, "shared.yml");
  const settings = await f.host.readProjectSettings("p");
  await f.host.saveProjectSettings(
    "p",
    { ...settings.value, profile: "shared" },
    settings.version,
  );
  const d = await f.host.readProjectDocument("p", target());
  const ticket = await f.host.prepareDocumentDeletion(source(), d.version);
  expect(ticket.profileFallback).toBe(false);
  f.trash.mockRejectedValueOnce(Error("controlled"));
  expect((await f.host.deleteDocument(ticket.token)).status).toBe(
    "not-trashed",
  );
  expect(await readFile(p, "utf8")).toBe(d.text);
  const stale = await f.host.prepareDocumentDeletion(source());
  await writeFile(p, "external: change\n");
  expect((await f.host.deleteDocument(stale.token)).status).toBe("not-trashed");
  const fresh = await f.host.prepareDocumentDeletion(source());
  expect((await f.host.deleteDocument(fresh.token)).status).toBe("trashed");
  const view = await f.host.readProjectSettings("p");
  expect(view.value.profile).toBe("shared");
  expect(view.profiles).toEqual([]);
});

it("blocks project profile deletion during an active run without stopping it", async () => {
  const f = await setup();
  const p = await f.file(f.root, "shared.yml");
  const ticket = await f.host.prepareDocumentDeletion(source());
  (f.host as any).runList.push({
    id: "active",
    projectId: "p",
    status: "running",
  });
  try {
    await expect(f.host.prepareDocumentDeletion(source())).rejects.toThrow(
      /работающ/,
    );
    expect((await f.host.deleteDocument(ticket.token)).status).toBe(
      "not-trashed",
    );
    expect(f.trash).not.toHaveBeenCalled();
    expect(f.runner.kill).not.toHaveBeenCalled();
    expect(await readFile(p, "utf8")).toBe("value: saved\n");
  } finally {
    (f.host as any).runList.length = 0;
  }
});
it("save and deletion invalidate old previews only for future launches", async () => {
  const f = await setup();
  await f.file(f.root, "shared.yml");
  await mkdir(path.join(f.root, ".goga/workflows"));
  await writeFile(path.join(f.root, ".goga/workflows/build.yml"), "{}\n");
  const request = {
    projectId: "p",
    pipeline: "build",
    workflow: "auto",
    profile: "shared",
    skips: [],
  };
  const first = await f.host.preview(request);
  expect((f.host as any).previews.has(first.token)).toBe(true);
  const doc = await f.host.readProjectDocument("p", target());
  await f.host.saveProjectDocument("p", target(), "updated: true", doc.version);
  expect((f.host as any).previews.has(first.token)).toBe(false);
  const second = await f.host.preview(request);
  const ticket = await f.host.prepareDocumentDeletion(source());
  await f.host.deleteDocument(ticket.token);
  expect((f.host as any).previews.has(second.token)).toBe(false);
  await expect(f.host.preview(request)).rejects.toThrow(/профиль/i);
  expect(f.runner.start).not.toHaveBeenCalled();
});
