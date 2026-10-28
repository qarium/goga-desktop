import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";

export function assertNativeArchitecture(output, arch) {
  if (
    !["arm64", "x64"].includes(arch) ||
    output.trim() !== (arch === "x64" ? "x86_64" : "arm64")
  )
    throw Error("Terminal native binary architecture mismatch.");
}
export function assertPackageTarget(context, arch = process.arch) {
  if (
    context.electronPlatformName !== "darwin" ||
    !["arm64", "x64"].includes(arch) ||
    context.arch !== (arch === "arm64" ? 3 : 1)
  )
    throw Error(
      "Terminal packaging requires a native macOS arm64/x64 build; cross-build is not supported.",
    );
}
export function terminalPackageFiles(app) {
  const resources = path.join(app, "Contents/Resources");
  return [
    path.join(resources, "terminal/terminal-inspect"),
    ...["pty.node", "spawn-helper"].map((f) =>
      path.join(
        resources,
        "app.asar.unpacked/node_modules/node-pty/build/Release",
        f,
      ),
    ),
  ];
}
export function nativeBuildCommands({
  root,
  platform,
  arch,
  machine,
  electronVersion,
  node,
}) {
  if (
    platform !== "darwin" ||
    !["arm64", "x64"].includes(arch) ||
    machine !== (arch === "arm64" ? "arm64" : "x86_64") ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    !/^\d+\.\d+\.\d+$/.test(electronVersion) ||
    !path.isAbsolute(node)
  )
    throw Error(
      "Terminal build requires a native macOS target and installed stable Electron.",
    );
  return [
    {
      file: node,
      args: [
        path.join(root, "node_modules/@electron/rebuild/lib/cli.js"),
        "--version",
        electronVersion,
        "--module-dir",
        root,
        "--only",
        "node-pty",
        "--arch",
        arch,
        "--force",
        "--build-from-source",
      ],
    },
    {
      file: "/usr/bin/clang",
      args: [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        "-arch",
        arch === "x64" ? "x86_64" : "arm64",
        path.join(root, "src/native/terminal-inspect.c"),
        "-lproc",
        "-o",
        path.join(root, "dist-electron/native/terminal-inspect"),
      ],
    },
  ];
}
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
export async function verifyNativeFiles(files, arch, execute = execFileSync) {
  for (const file of files) {
    const s = await lstat(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      (!file.endsWith(".node") && (s.mode & 0o111) === 0)
    )
      throw Error("Terminal native artifact must be a regular file.");
    assertNativeArchitecture(
      execute("/usr/bin/lipo", ["-archs", file], {
        encoding: "utf8",
        timeout: 10000,
      }),
      arch,
    );
  }
}
function developmentFiles(root) {
  return [
    path.join(root, "dist-electron/native/terminal-inspect"),
    ...["pty.node", "spawn-helper"].map((f) =>
      path.join(root, "node_modules/node-pty/build/Release", f),
    ),
  ];
}
async function assertPtyVersion(root) {
  const installed = JSON.parse(
    await readFile(
      path.join(root, "node_modules/node-pty/package.json"),
      "utf8",
    ),
  );
  if (installed.version !== "1.1.0")
    throw Error("Unsupported installed node-pty version.");
}
/** Electron 44 downloads lazily; a clean npm ci does not create dist.
 * Invoke only the installed lockfile package's installer with isolated build env,
 * then keep the existing native-architecture gate before rebuilding node-pty. */
export async function prepareElectronRuntime(
  root,
  arch,
  env,
  execute = execFileSync,
  verify = verifyNativeFiles,
) {
  execute(
    process.execPath,
    [path.join(root, "node_modules/electron/install.js")],
    {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 180000,
      killSignal: "SIGTERM",
    },
  );
  await verify(
    [
      path.join(
        root,
        "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      ),
    ],
    arch,
  );
}
export async function buildTerminalNative(root = process.cwd()) {
  await assertPtyVersion(root);
  const electronVersion = JSON.parse(
    await readFile(
      path.join(root, "node_modules/electron/package.json"),
      "utf8",
    ),
  ).version;
  const commands = nativeBuildCommands({
    root,
    platform: process.platform,
    arch: process.arch,
    machine: os.machine(),
    electronVersion,
    node: process.execPath,
  });
  const cache = path.join(root, "work/terminal-native-build");
  const out = path.join(root, "dist-electron/native");
  for (const dir of [
    out,
    ...["home", "tmp", "npm-cache"].map((d) => path.join(cache, d)),
  ])
    await mkdir(dir, { recursive: true });
  const manifest = path.join(out, "manifest.json");
  await unlink(manifest).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(cache, "home"),
    TMPDIR: path.join(cache, "tmp"),
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    npm_config_userconfig: "/dev/null",
    npm_config_cache: path.join(cache, "npm-cache"),
  };
  await prepareElectronRuntime(root, process.arch, env);
  for (const command of commands)
    execFileSync(command.file, command.args, {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 600000,
      killSignal: "SIGTERM",
    });
  const files = developmentFiles(root);
  await verifyNativeFiles(files, process.arch);
  await writeFile(
    manifest,
    JSON.stringify(
      {
        schemaVersion: 1,
        arch: process.arch,
        electronVersion,
        nodePtyVersion: "1.1.0",
        sha256: await Promise.all(files.map(digest)),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
export async function verifyTerminalBuild(
  root,
  electronVersion,
  arch = process.arch,
  execute = execFileSync,
) {
  await assertPtyVersion(root);
  const manifest = JSON.parse(
    await readFile(
      path.join(root, "dist-electron/native/manifest.json"),
      "utf8",
    ),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.arch !== arch ||
    manifest.electronVersion !== electronVersion ||
    manifest.nodePtyVersion !== "1.1.0"
  )
    throw Error("Terminal build manifest is stale; rebuild before packaging.");
  const files = developmentFiles(root);
  await verifyNativeFiles(files, arch, execute);
  if (
    JSON.stringify(await Promise.all(files.map(digest))) !==
    JSON.stringify(manifest.sha256)
  )
    throw Error("Terminal native files changed since the verified build.");
}
