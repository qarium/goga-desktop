import { describe, expect, it, afterEach, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  stat,
  symlink,
  chmod,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { TerminalPresetStore } from "../src/host/terminal-preset-store";
import { createTerminalPresetCrypto } from "../src/main/terminal-preset-crypto";
import {
  parseTerminalPresetEnv,
  parseTerminalPresetDraft,
} from "../src/shared/terminal-presets";
const bins: string[] = [],
  key = randomBytes(32);
const crypto = createTerminalPresetCrypto(
  {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const iv = randomBytes(12),
        enc = createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([
        iv,
        enc.update(plain, "utf8"),
        enc.final(),
        enc.getAuthTag(),
      ]);
    },
    decryptString: (b) => {
      const dec = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      dec.setAuthTag(b.subarray(-16));
      return Buffer.concat([
        dec.update(b.subarray(12, -16)),
        dec.final(),
      ]).toString("utf8");
    },
  },
  "darwin",
);
const owner = {
  tabId: "03e31f48-5ac5-4d64-ad92-bd9aa3bd8643",
  context: { kind: "primary", projectId: "p" },
} as const;
const draft = {
  name: "Локально",
  command: "echo UNIQUE_COMMAND",
  env: [{ key: "SID", value: "s3cr3t example $HOME “тест”" }],
};
async function fixture() {
  const home = await mkdtemp("/private/tmp/goga-terminal-preset-store-");
  bins.push(home);
  return {
    home,
    store: new TerminalPresetStore(home, crypto),
    file: join(home, ".goga/desktop/terminal-presets.json"),
  };
}
afterEach(async () => {
  await Promise.all(
    bins.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
describe("host-only private terminal presets", () => {
  it("does not consult the OS keyring to construct, list absent presets or remove unused snapshots", async () => {
    const { home, file } = await fixture();
    const check = vi.fn(() => false);
    const store = new TerminalPresetStore(
      home,
      createTerminalPresetCrypto(
        {
          isEncryptionAvailable: check,
          encryptString() {
            throw Error("unreachable");
          },
          decryptString() {
            throw Error("unreachable");
          },
        },
        "darwin",
      ),
    );
    expect(await store.menu()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.createSnapshot([], owner)).toBeUndefined();
    await store.collectSnapshots(new Set());
    expect(check).not.toHaveBeenCalled();
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.save(draft)).rejects.toThrow(/защит|шифр|ключ/i);
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("stores protected data separately from menu/summaries and keeps a tab snapshot after edit and removal", async () => {
    const { store, file, home } = await fixture(),
      original = await store.save(draft);
    expect(await store.menu()).toEqual([
      { id: original.id, revision: original.revision, name: draft.name },
    ]);
    expect(await store.list()).toEqual([
      {
        id: original.id,
        revision: original.revision,
        name: draft.name,
        command: draft.command,
        envCount: 1,
      },
    ]);
    const snap = await store.createSnapshot(original.env, owner);
    const changed = await store.save(
      { ...draft, env: [{ key: "SID", value: "" }] },
      original.id,
      original.revision,
    );
    expect(
      await new TerminalPresetStore(home, crypto).read(original.id),
    ).toEqual(changed);
    await store.remove(changed.id, changed.revision);
    expect(
      await new TerminalPresetStore(home, crypto).readSnapshot(snap!, owner),
    ).toEqual(draft.env);
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain("s3cr3t");
    expect(disk).not.toContain("UNIQUE_COMMAND");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.collectSnapshots(new Set([snap!]));
    expect(await readFile(file, "utf8")).toBe(disk);
    await store.removeSnapshot(snap!);
    await expect(store.readSnapshot(snap!, owner)).rejects.toThrow();
  });
  it("isolates record revisions and arbitrates concurrent name/remove collisions", async () => {
    const { store, home } = await fixture(),
      peer = new TerminalPresetStore(home, crypto);
    const [a, b] = await Promise.all([
      store.save(draft),
      peer.save({ ...draft, name: "Тест" }),
    ]);
    await Promise.all([
      store.save({ ...draft, name: "Dev" }, a.id, a.revision),
      peer.save({ ...draft, name: "Тесты" }, b.id, b.revision),
    ]);
    await expect(store.read(a.id, a.revision)).rejects.toThrow(/измен/);
    await expect(store.remove(b.id, b.revision)).rejects.toThrow(/измен/);
    await expect(store.save({ ...draft, name: "dev" })).rejects.toThrow(
      /названи/,
    );
    expect((await peer.menu()).map((i) => i.name).sort()).toEqual([
      "Dev",
      "Тесты",
    ]);
  });
  it("cannot disclose provider details or overwrite damaged or untrusted storage", async () => {
    const { store, home, file } = await fixture(),
      item = await store.save(draft),
      disk = await readFile(file, "utf8");
    expect(disk).not.toContain(draft.command);
    expect(disk).not.toContain(draft.env[0].value);
    const faulty = new TerminalPresetStore(
      home,
      createTerminalPresetCrypto(
        {
          isEncryptionAvailable: () => true,
          encryptString() {
            throw Error("SECRET");
          },
          decryptString() {
            throw Error("SECRET");
          },
        },
        "darwin",
      ),
    );
    expect(await faulty.menu()).toHaveLength(1);
    await expect(faulty.read(item.id)).rejects.toThrow(/расшифр|ключ/i);
    await expect(
      faulty.save(draft, item.id, item.revision),
    ).rejects.not.toThrow(/SECRET/);
    expect(await readFile(file, "utf8")).toBe(disk);
    await chmod(file, 0o644);
    await expect(store.menu()).rejects.toThrow();
    await chmod(file, 0o600);
    await writeFile(file, "broken");
    await expect(store.save(draft)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("broken");
    await rm(file);
    await symlink(join(home, "outside"), file);
    await expect(store.menu()).rejects.toThrow();
    await expect(stat(join(home, "outside"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("never opens a snapshot redirected to another tab, project or same-named topic copy", async () => {
    const { store } = await fixture(),
      topic = {
        kind: "topic",
        projectId: "p",
        topic: "ui",
        branch: "feature/ui",
        year: "2026",
        contextId: "ctx-" + "a".repeat(64),
      } as const;
    const bound = { ...owner, context: topic },
      ref = await store.createSnapshot(draft.env, bound);
    expect(await store.readSnapshot(ref!, bound)).toEqual(draft.env);
    for (const other of [
      { ...bound, tabId: "78f49ac7-3d05-4684-a7ca-a79d3e9a969b" },
      owner,
      { ...bound, context: { ...topic, projectId: "q" } },
      { ...bound, context: { ...topic, contextId: "ctx-" + "b".repeat(64) } },
    ]) {
      await expect(store.readSnapshot(ref!, other)).rejects.toThrow();
    }
  });
  it("rejects a swapped ciphertext before reading, replacing or deleting the wrong protected record", async () => {
    const { store, home, file } = await fixture(),
      a = await store.save(draft),
      b = await store.save({ ...draft, name: "B" });
    const sa = await store.createSnapshot(draft.env, owner),
      sb = await store.createSnapshot([{ key: "PORT", value: "4200" }], owner);
    const raw = JSON.parse(await readFile(file, "utf8"));
    [raw.presets[0].payload, raw.presets[1].payload] = [
      raw.presets[1].payload,
      raw.presets[0].payload,
    ];
    [raw.snapshots[0].payload, raw.snapshots[1].payload] = [
      raw.snapshots[1].payload,
      raw.snapshots[0].payload,
    ];
    const replaced = JSON.stringify(raw);
    await writeFile(file, replaced);
    const fresh = new TerminalPresetStore(home, crypto);
    await expect(fresh.read(a.id)).rejects.toThrow(/поврежд/);
    await expect(
      fresh.save({ ...draft, name: "new" }, a.id, a.revision),
    ).rejects.toThrow(/поврежд/);
    await expect(fresh.remove(b.id, b.revision)).rejects.toThrow(/поврежд/);
    await expect(fresh.readSnapshot(sa!, owner)).rejects.toThrow(/поврежд/);
    await expect(fresh.readSnapshot(sb!, owner)).rejects.toThrow(/поврежд/);
    expect(await readFile(file, "utf8")).toBe(replaced);
  });
  it("rejects wrong-platform or malformed encrypted payload without touching the keychain provider", () => {
    const check = vi.fn(() => true),
      storage = {
        isEncryptionAvailable: check,
        encryptString: () => Buffer.alloc(1),
        decryptString: () => "secret",
      };
    expect(() =>
      createTerminalPresetCrypto(storage, "linux").seal("value"),
    ).toThrow();
    expect(() =>
      createTerminalPresetCrypto(storage, "darwin").open("no!!"),
    ).toThrow();
    expect(check).not.toHaveBeenCalled();
  });
  it("validates env independent of Docker limits, never evaluates, trims or reports values", () => {
    const env = [
      { key: "PORT", value: "" },
      { key: "ApiToken", value: ' $x "a" ' },
      { key: "port", value: "a".repeat(65536) },
    ];
    expect(parseTerminalPresetEnv(env)).toEqual(env);
    for (const k of [
      "HOME",
      "DYLD_INJECT_LIBRARIES",
      "NODE_OPTIONS",
      "GIT_DIR",
      "PWD",
      "BASH_ENV",
      "PROMPT_COMMAND",
      "ZDOTDIR",
      "TERM_PROGRAM",
      "SHELL",
      "GOGA_TOKEN",
      "__proto__",
    ]) {
      expect(() =>
        parseTerminalPresetEnv([{ key: k, value: "secret" }]),
      ).toThrow();
    }
    for (const bad of [
      [env[0], env[0]],
      [{ key: "A", value: "\ud800" }],
      [{ key: "A", value: "secret\n" }],
      [{ key: "A", value: "😀".repeat(20000) }],
      Array(1),
      Array.from({ length: 257 }, (_, i) => ({ key: "A" + i, value: "" })),
      Array.from({ length: 4 }, (_, i) => ({
        key: "A" + i,
        value: "x".repeat(65536),
      })),
    ])
      expect(() => parseTerminalPresetEnv(bad)).toThrow();
    expect(() =>
      parseTerminalPresetDraft({ ...draft, command: "a\nb" }),
    ).toThrow();
    expect(() =>
      parseTerminalPresetDraft({ ...draft, command: "   " }),
    ).toThrow();
  });
});
