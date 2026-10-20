import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DesktopStateStore,
  validateProjectSettings,
} from "../src/host/desktop-state";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), link: vi.fn(actual.link) };
});

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((h) => fs.rm(h, { recursive: true, force: true })),
  );
});
async function setup(legacy?: unknown) {
  const home = await fs.mkdtemp("/private/tmp/goga-desktop-state-");
  homes.push(home);
  const old = path.join(home, "legacy");
  await fs.mkdir(old);
  if (legacy !== undefined)
    await fs.writeFile(path.join(old, "projects.json"), JSON.stringify(legacy));
  const store = new DesktopStateStore(home, old);
  const root = path.join(home, ".goga/desktop");
  return { home, old, store, root };
}
const project = (id = "stable-old-id") => ({
  id,
  name: "Example",
  path: `/example/${id}`,
});
const defaults = { executable: "goga", profile: "", env: [] };
const settingsPath = (root: string, id = "stable-old-id") =>
  path.join(
    root,
    "settings",
    `${createHash("sha256").update(id).digest("hex")}.json`,
  );

describe("Desktop project registry", () => {
  it("migrates legacy registry preserving IDs without changing its source", async () => {
    const p = project();
    const { store, old, root } = await setup([p]);
    const before = await fs.readFile(path.join(old, "projects.json"));
    expect(await store.listProjects()).toEqual([p]);
    expect(await fs.readFile(path.join(old, "projects.json"))).toEqual(before);
    expect(
      JSON.parse(await fs.readFile(path.join(root, "projects.json"), "utf8")),
    ).toMatchObject({ schemaVersion: 1, projects: [p] });
    await fs.writeFile(
      path.join(old, "projects.json"),
      "broken legacy, ignored after successful migration",
    );
    expect(await store.listProjects()).toEqual([p]);
  });
  it.each([
    [project(), null],
    [project(), { id: "other" }],
    [project(), project()],
    [project(), { ...project("other"), path: project().path }],
  ])(
    "rejects the whole malformed/conflicting legacy registry %#",
    async (...rows) => {
      const { store, root } = await setup(rows);
      await expect(store.listProjects()).rejects.toThrow();
      await expect(
        fs.stat(path.join(root, "projects.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it("refuses malformed JSON and unsupported registry schemas instead of resetting", async () => {
    const { store, root } = await setup([project()]);
    await store.listProjects();
    const file = path.join(root, "projects.json");
    const raw = await fs.readFile(file, "utf8");
    for (const changed of [
      "",
      JSON.stringify({ ...JSON.parse(raw), schemaVersion: 2 }),
      JSON.stringify({ ...JSON.parse(raw), projects: [project(), null] }),
    ]) {
      await fs.writeFile(file, changed);
      await expect(store.listProjects()).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(changed);
    }
  });
  it("never overwrites a destination created during initial migration", async () => {
    const { store, root } = await setup([project()]);
    const file = path.join(root, "projects.json");
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.link).mockImplementationOnce(async (source, destination) => {
      await fs.writeFile(destination, "external-conflict", { mode: 0o600 });
      return actual.link(source, destination);
    });
    await expect(store.listProjects()).rejects.toThrow(/измен/);
    expect(await fs.readFile(file, "utf8")).toBe("external-conflict");
    expect(await fs.readdir(root)).toEqual(["projects.json"]);
  });
  it("never replaces malformed current state from legacy", async () => {
    const { store, root } = await setup([project()]);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const file = path.join(root, "projects.json");
    await fs.writeFile(file, "DO NOT OVERWRITE", { mode: 0o600 });
    await expect(store.listProjects()).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe("DO NOT OVERWRITE");
  });
  it("merges additions from independent store instances without lost projects", async () => {
    const { store, home, old } = await setup();
    const other = new DesktopStateStore(home, old);
    await Promise.all([
      store.addProject(project("one")),
      other.addProject(project("two")),
    ]);
    expect((await store.listProjects()).map((p) => p.id).sort()).toEqual([
      "one",
      "two",
    ]);
    expect(await other.listProjects()).toEqual(await store.listProjects());
    expect(
      await other.addProject({ ...project("new"), path: project("one").path }),
    ).toEqual(project("one"));
    await expect(
      other.addProject({ ...project("one"), path: "/different" }),
    ).rejects.toThrow();
  });
});

describe("Desktop project settings", () => {
  it("persists private versioned defaults and roundtrips independent secret/runtime flags", async () => {
    const { store, root } = await setup([project()]);
    const initial = await store.read(project().id);
    expect(initial.value).toEqual(defaults);
    const value = {
      executable: "/Applications/My Goga/bin/goga",
      profile: "dev-1",
      env: [
        {
          key: "TOKEN",
          value: "secret = $ quoted ' value",
          secret: true,
          runtime: true,
        },
        { key: "PATH", value: "/custom/bin", secret: false, runtime: false },
        { key: "clientKey", value: "", secret: true, runtime: false },
        { key: "PUBLIC", value: "ok", secret: false, runtime: true },
      ],
    };
    const saved = await store.save(project().id, value, initial.version);
    expect(saved.value).toEqual(value);
    expect(saved.version).not.toBe(initial.version);
    expect(await store.read(project().id)).toEqual(saved);
    for (const file of [path.join(root, "projects.json"), settingsPath(root)])
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    for (const dir of [root, path.join(root, "settings")])
      expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect(
      JSON.parse(await fs.readFile(settingsPath(root), "utf8")),
    ).toMatchObject({ schemaVersion: 1, projectId: project().id, value });
  });
  it("copies input before waiting for another writer", async () => {
    const { store, root } = await setup([project()]);
    const initial = await store.read(project().id);
    const lock = path.join(root, ".write.lock");
    await fs.writeFile(lock, "temporary cooperating test owner", {
      mode: 0o600,
    });
    const input = {
      ...defaults,
      profile: "original",
      env: [{ key: "TOKEN", value: "original", runtime: true, secret: true }],
    };
    const pending = store.save(project().id, input, initial.version);
    input.profile = "mutated";
    input.env[0].value = "mutated";
    await fs.unlink(lock);
    const saved = await pending;
    expect(saved.value.profile).toBe("original");
    expect(saved.value.env[0].value).toBe("original");
  });
  it("isolates projects and returns detached values", async () => {
    const { store } = await setup([project("one"), project("two")]);
    const one = await store.read("one");
    await store.save("one", { ...defaults, profile: "one" }, one.version);
    expect((await store.read("two")).value).toEqual(defaults);
    const read = await store.read("one");
    read.value.profile = "mutated";
    expect((await store.read("one")).value.profile).toBe("one");
    await expect(store.read("../../unknown")).rejects.toThrow();
  });
  it("rejects stale and racing writers across instances", async () => {
    const { store, home, old } = await setup([project()]);
    const other = new DesktopStateStore(home, old);
    const initial = await store.read(project().id);
    const results = await Promise.allSettled([
      store.save(
        project().id,
        { ...defaults, profile: "one" },
        initial.version,
      ),
      other.save(
        project().id,
        { ...defaults, profile: "two" },
        initial.version,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(
      store.save(project().id, defaults, initial.version),
    ).rejects.toThrow(/измен|устар/i);
  });
  it("detects externally edited content even if revision was not changed", async () => {
    const { store, root } = await setup([project()]);
    const initial = await store.read(project().id);
    const file = settingsPath(root);
    const disk = JSON.parse(await fs.readFile(file, "utf8"));
    disk.value.profile = "external";
    await fs.writeFile(file, JSON.stringify(disk));
    await expect(
      store.save(project().id, defaults, initial.version),
    ).rejects.toThrow();
    expect((await store.read(project().id)).value.profile).toBe("external");
  });
  it("does not overwrite settings with a mismatched project or unsupported schema", async () => {
    const { store, root } = await setup([project()]);
    await store.read(project().id);
    const file = settingsPath(root);
    const disk = JSON.parse(await fs.readFile(file, "utf8"));
    for (const patch of [{ projectId: "different" }, { schemaVersion: 200 }]) {
      const raw = JSON.stringify({ ...disk, ...patch });
      await fs.writeFile(file, raw);
      await expect(store.read(project().id)).rejects.toThrow();
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    }
  });
  it("preserves old data and removes temporary files after write failure without leaking secrets", async () => {
    const { store, root } = await setup([project()]);
    const initial = await store.read(project().id);
    const file = settingsPath(root);
    const raw = await fs.readFile(file, "utf8");
    vi.mocked(fs.rename).mockRejectedValueOnce(
      new Error("ENOSPC private-secret-value"),
    );
    await expect(
      store.save(
        project().id,
        {
          ...defaults,
          env: [
            {
              key: "TOKEN",
              value: "private-secret-value",
              secret: true,
              runtime: false,
            },
          ],
        },
        initial.version,
      ),
    ).rejects.toThrow(/^Не удалось сохранить настройки Desktop\.$/);
    expect(await fs.readFile(file, "utf8")).toBe(raw);
    expect(await fs.readdir(path.dirname(file))).toEqual([path.basename(file)]);
    expect(await store.read(project().id)).toEqual(initial);
  });
});

describe("Desktop boundary security", () => {
  it.each([".goga", ".goga/desktop", ".goga/desktop/settings"])(
    "rejects symlinked storage directory %s",
    async (relative) => {
      const { store, home } = await setup([project()]);
      const external = path.join(home, "outside");
      await fs.mkdir(external);
      const link = path.join(home, relative);
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.symlink(external, link);
      await expect(store.read(project().id)).rejects.toThrow();
      expect(await fs.readdir(external)).toEqual([]);
    },
  );
  it("rejects symlinked state files and never touches their targets", async () => {
    const { store, home, root } = await setup([project()]);
    const initial = await store.read(project().id);
    const external = path.join(home, "outside-secret");
    await fs.writeFile(external, "outside-original");
    await fs.unlink(settingsPath(root));
    await fs.symlink(external, settingsPath(root));
    await expect(store.read(project().id)).rejects.toThrow();
    await expect(
      store.save(project().id, defaults, initial.version),
    ).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("outside-original");
  });
  it("rejects hardlinked settings and loose permissions without exposing file contents", async () => {
    const { store, root, home } = await setup([project()]);
    await store.read(project().id);
    const file = settingsPath(root);
    const hardlink = path.join(home, "outside-hardlink");
    await fs.link(file, hardlink);
    await expect(store.read(project().id)).rejects.toThrow();
    await fs.unlink(hardlink);
    await fs.chmod(file, 0o644);
    await expect(store.read(project().id)).rejects.toThrow();
  });
  it("rejects a symlinked lock without writing its target", async () => {
    const { store, root, home } = await setup();
    await store.listProjects();
    const outside = path.join(home, "lock-target");
    await fs.writeFile(outside, "unchanged");
    await fs.symlink(outside, path.join(root, ".write.lock"));
    await expect(store.listProjects()).rejects.toThrow();
    expect(await fs.readFile(outside, "utf8")).toBe("unchanged");
  });
  it("rejects symlinked legacy registry", async () => {
    const { store, old, home } = await setup();
    const external = path.join(home, "external.json");
    await fs.writeFile(external, JSON.stringify([project()]));
    await fs.symlink(external, path.join(old, "projects.json"));
    await expect(store.listProjects()).rejects.toThrow();
  });
  it("fails closed on an existing lock, without stealing it", async () => {
    const { store, root } = await setup();
    await store.listProjects();
    const file = path.join(root, ".write.lock");
    await fs.writeFile(file, "existing owner", { mode: 0o600 });
    await expect(store.addProject(project())).rejects.toThrow(/занят/i);
    expect(await fs.readFile(file, "utf8")).toBe("existing owner");
    expect(
      JSON.parse(await fs.readFile(path.join(root, "projects.json"), "utf8"))
        .projects,
    ).toEqual([]);
  });
});

describe("project settings validation", () => {
  it("clones and defaults absent row flags safely", () => {
    const original = { ...defaults, env: [{ key: "FOO", value: "bar" }] };
    expect(validateProjectSettings(original)).toEqual({
      ...defaults,
      env: [{ key: "FOO", value: "bar", secret: false, runtime: false }],
    });
  });
  it.each([false, true])(
    "rejects all Git control variables with runtime=%s",
    (runtime) => {
      for (const key of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_CONFIG",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        "GIT_OBJECT_DIRECTORY",
        "GIT_CUSTOM_FUTURE_CONTROL",
      ]) {
        expect(() =>
          validateProjectSettings({
            ...defaults,
            env: [
              { key, value: "private-path-or-secret", secret: true, runtime },
            ],
          }),
        ).toThrow(/^Недопустимые настройки проекта\.$/);
      }
    },
  );
  it.each(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])(
    "allows proxy %s for both host-only and explicit runtime forwarding",
    (key) => {
      const value = {
        ...defaults,
        env: [{ key, value: "https://proxy", runtime: false }],
      };
      expect(validateProjectSettings(value).env[0].runtime).toBe(false);
      expect(
        validateProjectSettings({
          ...value,
          env: [{ ...value.env[0], runtime: true, secret: true }],
        }).env[0],
      ).toEqual({ ...value.env[0], runtime: true, secret: true });
    },
  );
  it.each([
    "HOME",
    "GOGA_PROFILE",
    "GOGA_EXTRA_ENV",
    "GOGA_OTHER",
    "AFM_STATE",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONHOME",
    "NO_COLOR",
  ])("rejects control variable %s without echoing its value", (key) => {
    expect(() =>
      validateProjectSettings({
        ...defaults,
        env: [{ key, value: "secret-value" }],
      }),
    ).toThrow(/^Недопустимые настройки проекта\.$/);
  });
  it.each([
    { executable: "goga --help" },
    { executable: "./goga" },
    { executable: "goga;whoami" },
    { executable: "" },
    { executable: "goga\0" },
    { profile: "../private" },
    { env: [{ key: "1BAD", value: "x" }] },
    { env: [{ key: "A".repeat(129), value: "x" }] },
    { env: [{ key: "KEY", value: "x\nEVIL=1" }] },
    { env: [{ key: "KEY", value: "x\r" }] },
    { env: [{ key: "KEY", value: "x\0" }] },
    { env: [{ key: "KEY", value: 5 }] },
    { env: [{ key: "KEY", value: "x", secret: "true" }] },
    { env: [{ key: "KEY", value: "x", runtime: 1 }] },
    {
      env: [
        { key: "KEY", value: "a" },
        { key: "KEY", value: "b" },
      ],
    },
    { env: [{ key: "KEY", value: "x".repeat(65537) }] },
    {
      env: Array.from({ length: 257 }, (_, i) => ({
        key: `K${i}`,
        value: "x",
      })),
    },
  ])("rejects unsafe or oversized input %#", (patch) => {
    expect(() => validateProjectSettings({ ...defaults, ...patch })).toThrow(
      /^Недопустимые настройки проекта\.$/,
    );
  });
});

it.each(["x".repeat(50000), "a\ud800b", "a\udfffb"])(
  "rejects unsafe transport without changing persisted settings or revision %#",
  async (value) => {
    const { store, root } = await setup([project()]);
    const before = await store.read(project().id);
    const file = settingsPath(root);
    const raw = await fs.readFile(file);
    await expect(
      store.save(
        project().id,
        {
          ...defaults,
          env: [{ key: "AUDIT_BIG", value, secret: true, runtime: true }],
        },
        before.version,
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(raw);
    expect(await store.read(project().id)).toEqual(before);
    const external = JSON.parse(raw.toString());
    external.value.env = [
      { key: "AUDIT_BIG", value, secret: true, runtime: true },
    ];
    const externalRaw = JSON.stringify(external);
    await fs.writeFile(file, externalRaw);
    await expect(store.read(project().id)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(externalRaw);
  },
);

describe("startup timeout settings", () => {
  it.each([1, 10, 120])("keeps valid timeout %s", (startupTimeoutMinutes) => {
    expect(
      validateProjectSettings({ ...defaults, startupTimeoutMinutes }),
    ).toEqual({ ...defaults, startupTimeoutMinutes });
  });
  it.each([0, -1, 121, 1.5, NaN, Infinity, -Infinity, null, "10", true])(
    "rejects invalid timeout %s instead of discarding it",
    (startupTimeoutMinutes) => {
      expect(() =>
        validateProjectSettings({ ...defaults, startupTimeoutMinutes }),
      ).toThrow(/настройки/);
    },
  );
  it("keeps legacy documents and their versions unchanged until an explicit save", async () => {
    const { store, root } = await setup([project()]);
    const legacy = await store.read(project().id);
    const before = await fs.readFile(settingsPath(root), "utf8");
    expect(legacy.value).not.toHaveProperty("startupTimeoutMinutes");
    expect(await store.read(project().id)).toEqual(legacy);
    expect(await fs.readFile(settingsPath(root), "utf8")).toBe(before);
    const next = await store.save(
      project().id,
      { ...legacy.value, startupTimeoutMinutes: 120 },
      legacy.version,
    );
    expect(next.value.startupTimeoutMinutes).toBe(120);
    expect(await store.read(project().id)).toEqual(next);
    expect(next.version).not.toBe(legacy.version);
  });
  it("rejects invalid timeout saves without changing persisted state", async () => {
    const { store, root } = await setup([project()]);
    const initial = await store.read(project().id);
    const before = await fs.readFile(settingsPath(root), "utf8");
    await expect(
      store.save(
        project().id,
        { ...initial.value, startupTimeoutMinutes: 0 },
        initial.version,
      ),
    ).rejects.toThrow();
    expect(await fs.readFile(settingsPath(root), "utf8")).toBe(before);
  });
});
