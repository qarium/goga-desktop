import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  nativeBuildCommands,
  assertNativeArchitecture,
  terminalPackageFiles,
  assertPackageTarget,
} from "../terminal-native-build.mjs";
test("native build targets only installed Electron/node-pty on the native architecture", () => {
  const root = "/synthetic/project",
    plan = nativeBuildCommands({
      root,
      platform: "darwin",
      arch: "arm64",
      machine: "arm64",
      electronVersion: "44.8.0",
      node: "/node",
    });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].file, "/node");
  assert.deepEqual(plan[0].args, [
    root + "/node_modules/@electron/rebuild/lib/cli.js",
    "--version",
    "44.8.0",
    "--module-dir",
    root,
    "--only",
    "node-pty",
    "--arch",
    "arm64",
    "--force",
    "--build-from-source",
  ]);
  assert.equal(plan[1].file, "/usr/bin/clang");
  assert(plan[1].args.includes(root + "/src/native/terminal-inspect.c"));
  assert(plan[1].args.includes("-Werror"));
});
test("rejects unsupported, cross/translated build, version injection and relative root", () => {
  for (const override of [
    { platform: "linux" },
    { arch: "x64" },
    { machine: "x86_64" },
    { electronVersion: "44.8.0;bad" },
    { root: "relative" },
  ])
    assert.throws(() =>
      nativeBuildCommands({
        root: "/project",
        platform: "darwin",
        arch: "arm64",
        machine: "arm64",
        electronVersion: "44.8.0",
        node: "/node",
        ...override,
      }),
    );
  assert.doesNotThrow(() =>
    nativeBuildCommands({
      root: "/project",
      platform: "darwin",
      arch: "x64",
      machine: "x86_64",
      electronVersion: "44.8.0",
      node: "/node",
    }),
  );
});
test("binary architecture validation refuses universal/foreign/unexpected results", () => {
  assert.doesNotThrow(() => assertNativeArchitecture("arm64\n", "arm64"));
  assert.doesNotThrow(() => assertNativeArchitecture("x86_64\n", "x64"));
  for (const output of ["x86_64", "arm64 x86_64", "", "something arm64"])
    assert.throws(() => assertNativeArchitecture(output, "arm64"));
});
test("packaging requires native target and includes unpacked helpers for signature", () => {
  assert.doesNotThrow(() =>
    assertPackageTarget({ electronPlatformName: "darwin", arch: 3 }, "arm64"),
  );
  assert.doesNotThrow(() =>
    assertPackageTarget({ electronPlatformName: "darwin", arch: 1 }, "x64"),
  );
  for (const c of [
    { electronPlatformName: "darwin", arch: 1 },
    { electronPlatformName: "darwin", arch: 4 },
    { electronPlatformName: "linux", arch: 3 },
  ])
    assert.throws(() => assertPackageTarget(c, "arm64"));
  assert.deepEqual(terminalPackageFiles("/App.app"), [
    "/App.app/Contents/Resources/terminal/terminal-inspect",
    "/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
    "/App.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/spawn-helper",
  ]);
});
test("package/build contracts pin dependencies, preserve native binaries outside ASAR and isolate renderer", async () => {
  const p = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(p.dependencies["node-pty"], "1.1.0");
  assert.equal(p.dependencies["@xterm/xterm"], "6.0.0");
  assert.equal(p.dependencies["@xterm/addon-fit"], "0.11.0");
  assert.equal(p.devDependencies["@electron/rebuild"], "4.2.1");
  assert.equal(p.build.npmRebuild, false);
  assert(p.build.asarUnpack.includes("node_modules/node-pty/**"));
  assert(
    p.build.extraResources.some(
      (r) => r.from === "dist-electron/native" && r.to === "terminal",
    ),
  );
  assert.equal(p.build.beforePack, "scripts/terminal-before-pack.mjs");
  const build = await readFile(
    new URL("../build-main.mjs", import.meta.url),
    "utf8",
  );
  assert(build.includes('"node-pty"'));
  assert(build.includes('"src/main/terminal-preload.ts"'));
  assert(build.includes("buildTerminalNative"));
  const html = await readFile(
    new URL("../../src/terminal/terminal.html", import.meta.url),
    "utf8",
  );
  assert(html.includes("connect-src 'none'"));
  assert(!html.includes("unsafe-eval"));
  assert(html.includes('src="./entry.ts"'));
});

test("native verification rejects symlinks and non-executable helpers before lipo", async () => {
  const { mkdtemp, writeFile, chmod, symlink, rm } =
    await import("node:fs/promises");
  const { verifyNativeFiles } = await import("../terminal-native-build.mjs");
  const dir = await mkdtemp("/private/tmp/goga-native-build-test-");
  try {
    const file = dir + "/terminal-inspect";
    await writeFile(file, "synthetic", { mode: 0o600 });
    let calls = 0;
    const execute = () => {
      calls++;
      return "arm64";
    };
    await assert.rejects(verifyNativeFiles([file], "arm64", execute));
    assert.equal(calls, 0);
    await chmod(file, 0o700);
    await verifyNativeFiles([file], "arm64", execute);
    await symlink(file, dir + "/linked");
    await assert.rejects(
      verifyNativeFiles([dir + "/linked"], "arm64", execute),
    );
    assert.equal(calls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("packaging refuses stale hashes, Electron version or installed node-pty version", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { verifyTerminalBuild } = await import("../terminal-native-build.mjs");
  const dir = await mkdtemp("/private/tmp/goga-native-manifest-test-");
  try {
    await mkdir(dir + "/dist-electron/native", { recursive: true });
    await mkdir(dir + "/node_modules/node-pty/build/Release", {
      recursive: true,
    });
    const files = [
      dir + "/dist-electron/native/terminal-inspect",
      dir + "/node_modules/node-pty/build/Release/pty.node",
      dir + "/node_modules/node-pty/build/Release/spawn-helper",
    ];
    for (const file of files)
      await writeFile(file, "synthetic", { mode: 0o700 });
    const manifest = {
      schemaVersion: 1,
      arch: "arm64",
      electronVersion: "44.8.0",
      nodePtyVersion: "1.1.0",
      sha256: files.map(() =>
        createHash("sha256").update("synthetic").digest("hex"),
      ),
    };
    await writeFile(
      dir + "/dist-electron/native/manifest.json",
      JSON.stringify(manifest),
    );
    await writeFile(
      dir + "/node_modules/node-pty/package.json",
      JSON.stringify({ version: "1.1.0" }),
    );
    const execute = () => "arm64";
    await verifyTerminalBuild(dir, "44.8.0", "arm64", execute);
    await assert.rejects(
      verifyTerminalBuild(dir, "45.0.0", "arm64", execute),
      /stale/,
    );
    await writeFile(files[2], "changed");
    await assert.rejects(
      verifyTerminalBuild(dir, "44.8.0", "arm64", execute),
      /changed/,
    );
    await writeFile(files[2], "synthetic");
    await writeFile(
      dir + "/node_modules/node-pty/package.json",
      JSON.stringify({ version: "1.2.0" }),
    );
    await assert.rejects(
      verifyTerminalBuild(dir, "44.8.0", "arm64", execute),
      /node-pty/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("beforePack reads the actual Electron framework version from PlatformPackager", async () => {
  const { default: beforePack } = await import("../terminal-before-pack.mjs");
  const calls = [];
  await beforePack(
    {
      electronPlatformName: "darwin",
      arch: process.arch === "arm64" ? 3 : 1,
      packager: {
        projectDir: "/project",
        info: { framework: { version: "44.8.0" } },
      },
    },
    async (...args) => calls.push(args),
  );
  assert.deepEqual(calls, [["/project", "44.8.0"]]);
});

test("cold Electron setup installs the locked package before architecture verification", async () => {
  const { prepareElectronRuntime } =
    await import("../terminal-native-build.mjs");
  const calls = [];
  const env = { HOME: "/temporary/home", PATH: "/bin" };
  await prepareElectronRuntime(
    "/synthetic/project",
    "arm64",
    env,
    (file, args, options) => {
      calls.push("install");
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [
        "/synthetic/project/node_modules/electron/install.js",
      ]);
      assert.equal(options.env, env);
      assert.equal(options.cwd, "/synthetic/project");
      assert.equal(options.timeout, 180000);
      assert.equal(options.shell, undefined);
    },
    async (files, arch) => {
      calls.push("verify");
      assert.equal(arch, "arm64");
      assert.deepEqual(files, [
        "/synthetic/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ]);
    },
  );
  assert.deepEqual(calls, ["install", "verify"]);
  const source = await readFile(
    new URL("../terminal-native-build.mjs", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("export async function buildTerminalNative"),
  );
  assert.ok(
    body.indexOf("await prepareElectronRuntime(") <
      body.indexOf("for (const command of commands)"),
  );
});
test("Electron preparation propagates install and native verification failures", async () => {
  const { prepareElectronRuntime } =
    await import("../terminal-native-build.mjs");
  let verified = false;
  await assert.rejects(
    prepareElectronRuntime(
      "/synthetic",
      "arm64",
      {},
      () => {
        throw Error("download failed");
      },
      async () => {
        verified = true;
      },
    ),
    /download failed/,
  );
  assert.equal(verified, false);
  await assert.rejects(
    prepareElectronRuntime(
      "/synthetic",
      "arm64",
      {},
      () => {},
      async () => {
        throw Error("wrong architecture");
      },
    ),
    /wrong architecture/,
  );
});

test("download caches are explicit inside the isolated build root and do not inherit injection", async () => {
  const { terminalBuildEnvironment } =
    await import("../terminal-native-build.mjs");
  assert.equal(typeof terminalBuildEnvironment, "function");
  const env = await terminalBuildEnvironment("/synthetic/project", {
    PATH: "/usr/bin:/bin",
    HOME: "/user/home",
    NODE_OPTIONS: "--require=untrusted",
    NODE_PATH: "/user/modules",
    ELECTRON_OVERRIDE_DIST_PATH: "/foreign/binary",
    electron_config_cache: "/user/cache",
    TOKEN: "not-for-build",
  });
  assert.equal(env.HOME, "/synthetic/project/work/terminal-native-build/home");
  assert.equal(
    env.electron_config_cache,
    "/synthetic/project/work/terminal-native-build/downloads/electron",
  );
  assert.equal(
    env.npm_config_cache,
    "/synthetic/project/work/terminal-native-build/npm-cache",
  );
  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "TOKEN",
    "ELECTRON_OVERRIDE_DIST_PATH",
  ])
    assert.equal(env[name], undefined);
  assert.equal(env.PATH, "/usr/bin:/bin");
  for (const root of ["relative", "/project/../other", "/project\nbad"])
    await assert.rejects(terminalBuildEnvironment(root));
});

test("isolated build cache refuses symlinked ancestors instead of writing outside the checkout", async (t) => {
  const { terminalBuildEnvironment } =
    await import("../terminal-native-build.mjs");
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const root = await mkdtemp("/private/tmp/goga-build-cache-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + "/foreign");
  await symlink(root + "/foreign", root + "/work");
  await assert.rejects(terminalBuildEnvironment(root), /symbolic|symlink/i);
});

test("all writable isolated build roots reject sibling and cached-header symlinks", async (t) => {
  const { terminalBuildEnvironment } =
    await import("../terminal-native-build.mjs");
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const root = await mkdtemp("/private/tmp/goga-build-leaf-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + "/foreign");
  for (const leaf of ["home", "tmp", "npm-cache", "home/.electron-gyp"]) {
    const candidate = root + "/work/terminal-native-build/" + leaf;
    const path = await import("node:path");
    await mkdir(path.dirname(candidate), { recursive: true });
    await symlink(root + "/foreign", candidate);
    await assert.rejects(
      terminalBuildEnvironment(root),
      /symbolic|symlink/i,
      leaf,
    );
    await rm(candidate);
  }
});

test("restored nested cache entries cannot redirect subsequent header or cache writes", async (t) => {
  const { terminalBuildEnvironment } =
    await import("../terminal-native-build.mjs");
  const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const root = await mkdtemp("/private/tmp/goga-build-nested-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root + "/foreign");
  for (const leaf of [
    "home/.electron-gyp/44.8.0",
    "home/.electron-gyp/44.8.0/include/node",
    "npm-cache/_logs",
    "downloads/electron/version/archive.zip",
  ]) {
    const candidate = root + "/work/terminal-native-build/" + leaf;
    await mkdir(path.dirname(candidate), { recursive: true });
    await symlink(root + "/foreign", candidate);
    await assert.rejects(
      terminalBuildEnvironment(root),
      /symbolic|symlink/i,
      leaf,
    );
    await rm(candidate);
  }
});
