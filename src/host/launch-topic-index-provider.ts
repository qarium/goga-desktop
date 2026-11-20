import { access, open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { assertReadActive } from "./read-scope";

// Only the known console-script layout of a Python venv. Do not infer the
// interpreter from the user's PATH, or invoke a shell to interpret a launcher.
const consoleScript = [
  "import sys",
  "from goga.cli import app",
  "if __name__ == '__main__':",
  "    sys.argv[0] = sys.argv[0].removesuffix('.exe')",
  "    sys.exit(app())",
].join("\n");

function inProject(file: string, cwd: string) {
  const relative = path.relative(cwd, file);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function smallFile(file: string) {
  const fd = await open(
    file,
    constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY,
  );
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size < 1 || info.size > 4096) return;
    const data = Buffer.alloc(info.size);
    if ((await fd.read(data, 0, data.length, 0)).bytesRead === data.length)
      return data.toString("utf8");
  } finally {
    await fd.close();
  }
}

function isolatedVenv(config: string | undefined) {
  const entries = config
    ?.split(/\r?\n/)
    .filter((line) => /^\s*include-system-site-packages\s*=/i.test(line));
  return (
    entries?.length === 1 &&
    /^\s*include-system-site-packages\s*=\s*false\s*$/i.test(entries[0])
  );
}

async function findGit(search: string) {
  for (const dir of search.split(path.delimiter)) {
    if (!path.isAbsolute(dir)) return undefined;
    const candidate = path.join(dir, "git");
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined;
    }
  }
}

export function isSystemGitPair(a: string, b: string) {
  const known = (p: string) =>
    p === "/usr/bin/git" ||
    /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/git\/[A-Za-z0-9._-]+\/bin\/git$/.test(
      p,
    );
  return known(a) && known(b);
}

/** Most installations use a single Git; Finder may use Apple's /usr/bin/git
 * while the login shell uses Homebrew. Admit two only when the actual refs
 * will be checked with both, not with arbitrary command wrappers. */
export async function launchTopicGitPair(
  projectPath: string,
  appPath?: string,
): Promise<{ catalogGit?: string; desktopGit?: string } | undefined> {
  const desktop = appPath ?? process.env.PATH;
  if (!projectPath || projectPath === desktop) return {};
  if (!desktop) return;
  const [catalogGit, desktopGit] = await Promise.all([
    findGit(projectPath),
    findGit(desktop),
  ]);
  if (!catalogGit || !desktopGit) return;
  if (catalogGit === desktopGit) return {};
  return process.platform === "darwin" &&
    isSystemGitPair(catalogGit, desktopGit)
    ? { catalogGit, desktopGit }
    : undefined;
}
export async function launchTopicInterpreter(
  cwd: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const effective = { ...process.env, ...env };
  // -I ignores Python overrides. Do not project a CLI using a different module
  // search path, or project-specific Git options not used by normal desktop Git.
  if (
    Object.keys(effective).some(
      (k) =>
        effective[k] !== undefined &&
        /^PYTHON(?!DONTWRITEBYTECODE$|NOUSERSITE$)/.test(k),
    ) ||
    // The ordinary board inherits project HOME/XDG configuration; Desktop Git
    // does not. Even two identical executables could resolve different refs.
    Object.hasOwn(env, "HOME") || Object.hasOwn(env, "XDG_CONFIG_HOME") ||
    Object.keys(env).some(
      (k) => k.startsWith("GIT_") && env[k] !== process.env[k],
    )
  )
    return;
  let file: string | undefined;
  if (path.isAbsolute(executable) && path.basename(executable) === "goga")
    file = executable;
  else if (executable === "goga") {
    if (!effective.PATH) return;
    for (const dir of effective.PATH.split(path.delimiter)) {
      if (!path.isAbsolute(dir)) return;
      const candidate = path.join(dir, executable);
      try {
        await access(candidate, constants.X_OK);
        file = candidate;
        break;
      } catch (e) {
        if (
          !["ENOENT", "ENOTDIR", "EACCES"].includes(
            (e as NodeJS.ErrnoException).code ?? "",
          )
        )
          return;
      }
    }
  }
  if (!file || inProject(file, cwd)) return;
  try {
    const launcher = await realpath(file),
      bin = path.dirname(launcher);
    if (
      path.basename(launcher) !== "goga" ||
      path.basename(bin) !== "bin" ||
      inProject(launcher, cwd)
    )
      return;
    await access(launcher, constants.X_OK);
    if (!(await stat(launcher)).isFile()) return;
    const stub = await smallFile(launcher);
    if (!stub) return;
    const newline = stub.indexOf("\n");
    if (
      newline < 0 ||
      !stub.startsWith("#!") ||
      stub.slice(newline + 1).trimEnd() !== consoleScript
    )
      return;
    const python = stub.slice(2, newline);
    if (
      /[\s\0]/.test(python) ||
      path.dirname(python) !== bin ||
      !/^python(?:3(?:\.\d+)?)?$/.test(path.basename(python))
    )
      return;
    const venv = path.dirname(bin);
    if (
      !isolatedVenv(await smallFile(path.join(venv, "pyvenv.cfg"))) ||
      inProject(await realpath(python), cwd) ||
      !(await stat(python)).isFile()
    )
      return;
    await access(python, constants.X_OK);
    assertReadActive();
    // Do not canonicalize this path: CPython looks up its venv via the original invocation path.
    return python;
  } catch {
    assertReadActive();
    return;
  }
}

// Static host code; the only input is JSON over stdin. No interpolation of any
// user path or shell text. 74 means incompatibility *before* arbitrary hooks.
// All hook errors are terminal for this read (never silently dispatch twice).
export const launchTopicRanksProgram = `
import sys, json, contextlib, importlib.metadata
def main():
    try:
        # This adapter mirrors catalog semantics of these exact builds, not
        # every release sharing a major/minor or the same private API names.
        if importlib.metadata.version("goga") not in ("2.1.1", "2.1.2.dev21+gf71c19ed0"):
            return 74
        if sys.argv[1:] == ["--check-version"]:
            return 0
        from goga.commands.topics.topics import _topics_section
        from goga.history import assemble_status_scale
    except (ImportError, importlib.metadata.PackageNotFoundError):
        return 74
    groups = json.load(sys.stdin)
    with contextlib.redirect_stdout(sys.stderr):
        _topics_section()
        scale = assemble_status_scale()
        rank = {stage.name: i for i, stage in enumerate(scale.stages)}
        result = [rank[scale.maximal_present(group)[0]] for group in groups]
    json.dump(result, sys.stdout)
    return 0
try:
    code = main()
except BaseException:
    code = 1
sys.exit(code)
`;
