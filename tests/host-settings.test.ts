import { it, expect, afterEach } from "vitest";
import { mkdtemp, readFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsStore } from "../src/host/settings";
const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((h) => rm(h, { recursive: true, force: true })),
  );
});
async function setup() {
  const h = await mkdtemp("/private/tmp/goga-home-");
  homes.push(h);
  return { h, s: new SettingsStore(h) };
}
it("writes atomically preserving comments and guards optimistic versions", async () => {
  const { h, s } = await setup();
  const initial = await s.readSettings("config");
  const text =
    '# keep\nenv:\n  TOKEN: private\ndocker:\n  run: ["--network=host"]\ncustom: true\n';
  await s.saveSettings("config", undefined, text, initial.version);
  expect(await readFile(path.join(h, ".goga/config.yml"), "utf8")).toBe(text);
  await expect(
    s.saveSettings("config", undefined, "{}", initial.version),
  ).rejects.toThrow(/измен/);
  expect(await s.listSettings()).toEqual({ configExists: true, profiles: [] });
});
it("rejects malformed mapping, docker types, traversal and symlinks", async () => {
  const { h, s } = await setup();
  for (const text of ["- x", "env: []", "docker:\n  run: abc"])
    await expect(
      s.saveSettings("config", undefined, text, "missing"),
    ).rejects.toThrow();
  await expect(s.readSettings("profile", "../x")).rejects.toThrow();
  await mkdir(path.join(h, ".goga"));
  await symlink(h, path.join(h, ".goga/profiles"));
  await expect(s.readSettings("profile", "x")).rejects.toThrow(/Символ/);
});
it("lists and creates personal profile without touching project", async () => {
  const { s } = await setup();
  await s.saveSettings(
    "profile",
    "dev",
    "# comment\nagent: codex\n",
    "missing",
  );
  expect((await s.listSettings()).profiles).toEqual(["dev"]);
  expect((await s.readSettings("profile", "dev")).text).toContain("# comment");
});
it("rejects unbalanced docker fragments and profiles with non-JSON YAML types", async () => {
  const { s } = await setup();
  await expect(
    s.saveSettings(
      "config",
      undefined,
      `docker:\n  run:\n    - '--env="oops'\n`,
      "missing",
    ),
  ).rejects.toThrow();
  await expect(
    s.saveSettings("profile", "dev", "when: 2026-10-16\n", "missing"),
  ).rejects.toThrow();
});

it.each(["config", "profile"] as const)(
  "roundtrips rich %s YAML verbatim in a temporary HOME and preserves conflicts",
  async (kind) => {
    const { h, s } = await setup();
    const name = kind === "profile" ? "synthetic" : undefined;
    const text =
      '# Синтетический документ 🙂\r\nunknown_custom:\n  enabled: true\r\n  retries: 42\n  label: "quoted: value" # комментарий\r\nprompt: |-\n  Первая строка\n  Вторая строка \\n literal\nenv:\n  DEMO: \'<img src=x onerror="danger()">\'\n';
    const initial = await s.readSettings(kind, name);
    const saved = await s.saveSettings(kind, name, text, initial.version);
    expect(saved.text).toBe(text);
    const file = path.join(
      h,
      ".goga",
      kind === "config" ? "config.yml" : "profiles/synthetic.yml",
    );
    expect(await readFile(file)).toEqual(Buffer.from(text));
    expect((await s.readSettings(kind, name)).text).toBe(text);
    await expect(
      s.saveSettings(kind, name, "broken: [", saved.version),
    ).rejects.toThrow();
    expect(await readFile(file)).toEqual(Buffer.from(text));
    const { writeFile } = await import("node:fs/promises");
    const external = text + "# external edit\n";
    await writeFile(file, external);
    await expect(
      s.saveSettings(kind, name, text + "# draft\n", saved.version),
    ).rejects.toThrow(/измен/);
    expect(await readFile(file, "utf8")).toBe(external);
  },
);
