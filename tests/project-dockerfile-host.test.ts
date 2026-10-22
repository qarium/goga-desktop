import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  link,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { DesktopStateStore } from "../src/host/desktop-state";
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
async function setup(value = "null") {
  const dir = await mkdtemp("/private/tmp/dockerfile-test-");
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project"),
    home = path.join(dir, "home"),
    data = path.join(dir, "data");
  await mkdir(root);
  await mkdir(home);
  await mkdir(path.join(root, ".goga"));
  await writeFile(path.join(root, ".goga/config.yml"), "unchanged: true\n");
  const state = new DesktopStateStore(home, data);
  await state.addProject({ id: "p", name: "P", path: root });
  const command = vi.fn(async () => ({
    stdout: `# dockerfile\n${value}\n`,
    stderr: "",
  }));
  const host = new HostService({
    home,
    dataDir: data,
    runner: { command } as any,
  });
  clean.push(() => host.dispose());
  return {
    root,
    host,
    state,
    command,
    set: (v: string) => {
      value = v;
    },
  };
}
it("resolves null using exact scoped config command without mutating config; creates only on save and preserves raw syntax", async () => {
  const { root, host, command } = await setup();
  expect(await host.resolveProjectDockerfile("p")).toEqual({
    relativePath: ".goga/Dockerfile",
    configured: false,
  });
  expect(command).toHaveBeenCalledWith(
    expect.any(String),
    ["config", "dockerfile"],
    root,
    expect.any(Object),
  );
  const target = { kind: "dockerfile", path: ".goga/Dockerfile" } as const;
  const before = await host.readProjectDocument("p", target);
  expect(before.exists).toBe(false);
  await expect(readFile(path.join(root, target.path))).rejects.toThrow();
  const text = "\ufeffFROM alpine\r\nRUN [broken: {{ raw }}\r\n";
  await host.saveProjectDocument("p", target, text, before.version);
  expect(await readFile(path.join(root, target.path), "utf8")).toBe(text);
  expect(await readFile(path.join(root, ".goga/config.yml"), "utf8")).toBe(
    "unchanged: true\n",
  );
});
it("opens existing fallback and rejects external file/config changes and arbitrary destinations", async () => {
  const { root, host, set } = await setup();
  const target = { kind: "dockerfile", path: ".goga/Dockerfile" } as const;
  await writeFile(path.join(root, target.path), "FROM existing");
  const before = await host.readProjectDocument("p", target);
  expect(before.text).toBe("FROM existing");
  await writeFile(path.join(root, target.path), "FROM external");
  await expect(
    host.saveProjectDocument("p", target, "FROM new", before.version),
  ).rejects.toThrow();
  const fresh = await host.readProjectDocument("p", target);
  set(".goga/Dockerfile");
  await expect(
    host.saveProjectDocument("p", target, "FROM new", fresh.version),
  ).rejects.toThrow();
  await expect(
    host.readProjectDocument("p", { kind: "dockerfile", path: "other" }),
  ).rejects.toThrow();
});
it.each([
  "../outside",
  ".git/config",
  ".goga/config.yml",
  ".GIT/config",
  ".goga/CONFIG.YML",
  "a/../Dockerfile",
  "",
  "a\nb",
])("rejects unsafe configured path %s", async (value) => {
  const { host } = await setup(value);
  await expect(host.resolveProjectDockerfile("p")).rejects.toThrow();
});
it.each(["123", "true", "Dockerfile # dev", '"quoted"'])(
  "treats CLI scalar %s as literal filename",
  async (value) => {
    const { host } = await setup(value);
    expect(await host.resolveProjectDockerfile("p")).toEqual({
      relativePath: value,
      configured: true,
    });
  },
);
it("normalizes an internal absolute path and rejects links and CLI failure", async () => {
  const { root, host, set, command } = await setup();
  set(path.join(root, "Dockerfile"));
  expect((await host.resolveProjectDockerfile("p")).relativePath).toBe(
    "Dockerfile",
  );
  await writeFile(path.join(root, "original"), "FROM alpine");
  await symlink("original", path.join(root, "Dockerfile"));
  await expect(host.resolveProjectDockerfile("p")).rejects.toThrow();
  await rm(path.join(root, "Dockerfile"));
  await link(path.join(root, "original"), path.join(root, "Dockerfile"));
  await expect(host.resolveProjectDockerfile("p")).rejects.toThrow();
  command.mockRejectedValueOnce(Error("failed"));
  await expect(host.resolveProjectDockerfile("p")).rejects.toThrow();
});
it("rechecks external changes after the asynchronous final config guard", async () => {
  const { root, host, command } = await setup("Dockerfile");
  const target = { kind: "dockerfile", path: "Dockerfile" } as const;
  await writeFile(path.join(root, target.path), "original");
  const before = await host.readProjectDocument("p", target);
  let calls = 0;
  command.mockImplementation(async () => {
    if (++calls === 3)
      await writeFile(path.join(root, target.path), "external");
    return { stdout: "# dockerfile\nDockerfile\n", stderr: "" };
  });
  await expect(
    host.saveProjectDocument("p", target, "draft", before.version),
  ).rejects.toThrow();
  expect(await readFile(path.join(root, target.path), "utf8")).toBe("external");
});
it("creates configured missing ancestors only on save, rejects oversize and non-UTF8 source", async () => {
  const { root, host } = await setup("build/image/Dockerfile");
  const target = {
    kind: "dockerfile",
    path: "build/image/Dockerfile",
  } as const;
  const before = await host.readProjectDocument("p", target);
  await expect(readFile(path.join(root, "build"))).rejects.toThrow();
  await expect(
    host.saveProjectDocument(
      "p",
      target,
      "a".repeat(1024 * 1024 + 1),
      before.version,
    ),
  ).rejects.toThrow();
  await host.saveProjectDocument("p", target, "FROM alpine", before.version);
  expect(await readFile(path.join(root, target.path), "utf8")).toBe(
    "FROM alpine",
  );
  await writeFile(path.join(root, target.path), Buffer.from([0xff]));
  await expect(host.readProjectDocument("p", target)).rejects.toThrow(/UTF-8/);
});

it("rejects Desktop settings changed during the final config guard without overwriting Dockerfile or Goga config", async () => {
  const { root, host, state, command } = await setup("Dockerfile");
  const target = { kind: "dockerfile", path: "Dockerfile" } as const;
  await writeFile(path.join(root, target.path), "FROM original");
  const before = await host.readProjectDocument("p", target);
  const settings = await state.read("p");
  let calls = 0;
  command.mockImplementation(async () => {
    if (++calls === 3) {
      await state.save(
        "p",
        {
          ...settings.value,
          startupTimeoutMinutes:
            (settings.value.startupTimeoutMinutes ?? 5) + 1,
        },
        settings.version,
      );
    }
    return { stdout: "# dockerfile\nDockerfile\n", stderr: "" };
  });
  await expect(
    host.saveProjectDocument("p", target, "FROM draft", before.version),
  ).rejects.toThrow(/Настройки проекта изменились/);
  expect(calls).toBe(3);
  expect(await readFile(path.join(root, target.path), "utf8")).toBe(
    "FROM original",
  );
  expect(await readFile(path.join(root, ".goga/config.yml"), "utf8")).toBe(
    "unchanged: true\n",
  );
  expect((await state.read("p")).version).not.toBe(settings.version);
});

it.each(["./.goga/Dockerfile", ".goga/./Dockerfile", ".goga//Dockerfile"])(
  "normalizes safe relative configured path %s",
  async (value) => {
    const { host } = await setup(value);
    expect(await host.resolveProjectDockerfile("p")).toEqual({
      relativePath: ".goga/Dockerfile",
      configured: true,
    });
  },
);
it.each([
  "./.git/config",
  ".goga/./config.yml",
  ".goga//config.yml",
  "./build/../Dockerfile",
])(
  "rejects protected or traversing aliases before/after normalization %s",
  async (value) => {
    const { host } = await setup(value);
    await expect(host.resolveProjectDockerfile("p")).rejects.toThrow();
  },
);

it("rejects a parent directory swapped during the final asynchronous config guard", async () => {
  const { root, host, command } = await setup("build/Dockerfile");
  await mkdir(path.join(root, "build"));
  const target = { kind: "dockerfile", path: "build/Dockerfile" } as const;
  await writeFile(path.join(root, target.path), "FROM original");
  const before = await host.readProjectDocument("p", target);
  let calls = 0;
  command.mockImplementation(async () => {
    if (++calls === 3) {
      await rename(path.join(root, "build"), path.join(root, "original-build"));
      await mkdir(path.join(root, "build"));
      await writeFile(path.join(root, target.path), "FROM external");
    }
    return { stdout: "# dockerfile\nbuild/Dockerfile\n", stderr: "" };
  });
  await expect(
    host.saveProjectDocument("p", target, "FROM draft", before.version),
  ).rejects.toThrow(/измен/);
  expect(calls).toBe(3);
  expect(await readFile(path.join(root, target.path), "utf8")).toBe(
    "FROM external",
  );
  expect(
    await readFile(path.join(root, "original-build/Dockerfile"), "utf8"),
  ).toBe("FROM original");
  expect(await readFile(path.join(root, ".goga/config.yml"), "utf8")).toBe(
    "unchanged: true\n",
  );
});
