import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { noSymlinks } from "./settings";
import { RunnerShutdownError } from "./process";
import { assertReadActive } from "./read-scope";

const invalid = () =>
  Error(
    "Не удалось безопасно перенести локальные настройки Git. Копия не подготовлена; значения настроек скрыты.",
  );
const limit = 1024 * 1024;
const allowed = [
  /^user\.(?:name|email|useconfigonly|signingkey)$/,
  /^(?:author|committer)\.(?:name|email)$/,
  /^commit\.(?:gpgsign|template|cleanup|status|verbose)$/,
  /^tag\.(?:gpgsign|forcesignannotated)$/,
  /^gpg\.(?:format|program|mintrustlevel|(?:openpgp|x509|ssh)\.program|ssh\.(?:allowedsignersfile|revocationfile|defaultkeycommand))$/,
  /^core\.(?:sshcommand|autocrlf|eol|safecrlf|filemode|symlinks|ignorecase|precomposeunicode|protecthfs|protectntfs|whitespace|attributesfile|excludesfile|editor|pager|quotepath|abbrev|commentchar|commentstring)$/,
  /^ssh\.variant$/,
  /^credential\.(?:.*\.)?(?:helper|username|usehttppath|interactive)$/,
  /^diff\.(?:algorithm|indentheuristic|renames|renamelimit|context|interhunkcontext|colormoved|colormovedws|wordregex|wserrorhighlight|mnemonicprefix|noprefix|srcprefix|dstprefix|submodule|statgraphwidth|statnamewidth|statwidth|external|tool|guitool)$/,
  /^diff\..+\.(?:binary|wordregex|xfuncname|funcname|algorithm)$/,
  /^merge\.(?:ff|conflictstyle|renames|renamelimit|renormalize|log|stat|suppressdest|tool|guitool|verbosity|directoryrenames|autostash|verifysignatures)$/,
  /^pull\.(?:rebase|ff|octopus|twohead)$/,
  /^rebase\.(?:autostash|autosquash|abbreviatecommands|updaterefs|stat|missingcommitscheck|instructionformat|backend|reschedulefailedexec)$/,
  /^branch\.(?:autosetupmerge|autosetuprebase)$/,
  /^fetch\.(?:prune|prunetags|showforcedupdates)$/,
  /^(?:alias|color|pager)\..+$/,
  /^log\.(?:date|decorate|abbrevcommit|graphcolors|showsignature)$/,
  /^(?:difftool|mergetool)\.(?:prompt|keepbackup|keeptemporaries|writebackup|hideResolved|.*\.(?:cmd|path|trustexitcode))$/i,
];
const fileKeys = new Set([
  "commit.template",
  "core.attributesfile",
  "core.excludesfile",
  "gpg.ssh.allowedsignersfile",
  "gpg.ssh.revocationfile",
]);
function parse(raw: string): [string, string | null][] {
  if (Buffer.byteLength(raw) > limit || (raw && !raw.endsWith("\0")))
    throw invalid();
  const result: [string, string | null][] = [];
  for (const row of raw.split("\0").filter(Boolean)) {
    const split = row.indexOf("\n"),
      key = split < 0 ? row : row.slice(0, split);
    if (!/^[A-Za-z][A-Za-z0-9-]*\.[^\0\r\n=]+$/.test(key)) throw invalid();
    result.push([key, split < 0 ? null : row.slice(split + 1)]);
    if (result.length > 8192) throw invalid();
  }
  return result;
}
const stamp = (s: Awaited<ReturnType<typeof fs.lstat>>) =>
  [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
async function directory(p: string) {
  await noSymlinks(p);
  const s = await fs.lstat(p);
  if (!s.isDirectory() || (await fs.realpath(p)) !== p) throw invalid();
  return [s.dev, s.ino, s.mode].join(":");
}
async function infoFile(p: string): Promise<Buffer | null> {
  await noSymlinks(p);
  let h;
  try {
    h = await fs.open(
      p,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await h.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      throw invalid();
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await h.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    await noSymlinks(p);
    if (
      offset !== before.size ||
      stamp(before) !== stamp(await h.stat()) ||
      stamp(before) !== stamp(await fs.lstat(p))
    )
      throw invalid();
    return bytes.subarray(0, offset);
  } finally {
    await h.close();
  }
}
/** A snapshot at creation only. Never replay includes, remotes, branch tracking,
 * repository topology, hooks, filters, merge drivers or credential-store files. */
export async function withCloneGitSettings<T>(
  options: {
    root: string;
    gitDir: string;
    git(args: string[]): Promise<string>;
  },
  action: (settings: { args: string[]; verify(): Promise<void> }) => Promise<T>,
): Promise<T> {
  let template: string | undefined,
    templateIdentity: string | undefined,
    actionStarted = false;
  try {
    const rootIdentity = await directory(options.root),
      gitIdentity = await directory(options.gitDir);
    const read = () =>
      options.git(["config", "--local", "--includes", "--null", "--list"]);
    const raw = await read(),
      rows = parse(raw);
    const selected = rows.filter(([key]) =>
      allowed.some((pattern) => pattern.test(key.toLowerCase())),
    );
    const last = (key: string) =>
      selected.filter(([k]) => k.toLowerCase() === key).at(-1)?.[1];
    const sshSigning = last("gpg.format")?.toLowerCase() === "ssh";
    const args: string[] = [];
    for (const [key, value] of selected) {
      const lower = key.toLowerCase();
      let next = value;
      if (next !== null) {
        const signingFile =
          lower === "user.signingkey" &&
          sshSigning &&
          !/^(?:key::|(?:ssh-|ecdsa-|sk-)[^\s]+[ \t])/.test(next);
        const programFile =
          /^(?:gpg(?:\.(?:ssh|x509|openpgp))?\.program|(?:diff|merge)tool\..+\.path)$/.test(
            lower,
          ) && /[\/\\~]/.test(next);
        if (fileKeys.has(lower) || signingFile || programFile) {
          if (!next) throw invalid();
          // Let Git expand ~user and parse pathname values. Relative file-valued
          // settings address the original working directory, not the new clone.
          const expanded = await options.git([
            "config",
            "--local",
            "--includes",
            "--type=path",
            "--null",
            "--get-all",
            key,
          ]);
          if (!expanded.endsWith("\0")) throw invalid();
          const values = expanded.slice(0, -1).split("\0");
          const index = rows
            .filter(([k]) => k.toLowerCase() === lower)
            .findIndex(([, v]) => v === value);
          next = path.resolve(options.root, values[index] ?? "");
          if (!values[index]) throw invalid();
        }
      }
      if (lower === "core.sshcommand" && next) {
        // SSH commands may refer to untracked project-local keys/scripts. Keep
        // their original cwd; never copy private resources or parse shell code.
        const quotedRoot = "'" + options.root.replace(/'/g, "'\\''") + "'";
        next = `cd ${quotedRoot} && ${next}`;
      }
      args.push("--config", key + (next === null ? "" : "=" + next));
    }
    if (Buffer.byteLength(args.join("\0")) > 65536 || selected.length > 512)
      throw invalid();
    const files = new Map<string, Buffer>();
    for (const name of ["exclude", "attributes"]) {
      const bytes = await infoFile(path.join(options.gitDir, "info", name));
      if (bytes) files.set(name, bytes);
    }
    const verify = async () => {
      if (
        (await directory(options.root)) !== rootIdentity ||
        (await directory(options.gitDir)) !== gitIdentity ||
        (await read()) !== raw
      )
        throw invalid();
      for (const name of ["exclude", "attributes"]) {
        const current = await infoFile(path.join(options.gitDir, "info", name)),
          before = files.get(name);
        if (before ? !current?.equals(before) : current !== null)
          throw invalid();
      }
    };
    await verify();
    template = await fs.mkdtemp(path.join(tmpdir(), "goga-clone-template-"));
    template = await fs.realpath(template);
    await fs.chmod(template, 0o700);
    templateIdentity = await directory(template);
    if (files.size) {
      await fs.mkdir(path.join(template, "info"), { mode: 0o700 });
      for (const [name, bytes] of files)
        await fs.writeFile(path.join(template, "info", name), bytes, {
          flag: "wx",
          mode: 0o600,
        });
    }
    actionStarted = true;
    return await action({ args: ["--template=" + template, ...args], verify });
  } catch (error) {
    // Cancellation retains its real read/shutdown semantics in the caller;
    // preparation errors never expose source config or shell command values.
    assertReadActive();
    if (actionStarted || error instanceof RunnerShutdownError) throw error;
    throw invalid();
  } finally {
    if (template) {
      if ((await directory(template)) !== templateIdentity) throw invalid();
      await fs.rm(template, { recursive: true });
    }
  }
}
