import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import {
  gitFilePathSchema,
  type GitWorkspaceSnapshot,
} from "../shared/git-workspace";
import {
  gitConflictReadRequestSchema,
  type GitConflictBlock,
  type GitConflictBlockSource,
  type GitConflictDocument,
  type GitConflictGenerated,
  type GitConflictReadRequest,
  type GitConflictSource,
} from "../shared/git-conflicts";
import { CommandExitError } from "./process";
import {
  readGitConflictSaveFingerprint,
  type StoppedRebaseConflictBinding,
} from "./git-conflict-state";

export interface GitConflictContext {
  readonly stoppedRebase?: StoppedRebaseConflictBinding;
  scope: ScopeRef;
  root: string;
  ownerKey: string;
  /** The existing GitWorkspaceReader supplies owner and no-follow topology validation. */
  snapshot(): Promise<GitWorkspaceSnapshot>;
  verify(): Promise<void>;
  /** Host-bound offline, bounded runner; no lazy-fetch or inherited Git environment. */
  git(args: string[]): Promise<{ stdout: string; stderr: string }>;
}
const LIMIT = 1024 * 1024;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const stale = () =>
  Error("Снимок конфликта Git устарел. Обновите список изменений.");
class MappingUnavailable extends Error {}
const invalid = () => Error("Некорректный ответ Git при чтении конфликта.");
const safeArgs = [
  "--no-pager",
  "--literal-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "diff.external=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "color.ui=false",
];
const stat = (filename: string) =>
  fs.lstat(filename, { bigint: true }).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  });
const stamp = (info: Awaited<ReturnType<typeof stat>>) =>
  info
    ? [
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
      ].join(":")
    : "missing";
async function regular(
  filename: string,
  limit: number,
  checkParents?: () => Promise<void>,
): Promise<{ bytes: Buffer; identity: string } | null> {
  const before = await stat(filename);
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(limit)
  )
    throw Error("Небезопасный тип или слишком большой размер файла Git.");
  await checkParents?.();
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    await checkParents?.();
    if (stamp(await handle.stat({ bigint: true })) !== stamp(before))
      throw stale();
    // Bounded even if another process grows the file after lstat.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (
      size !== Number(before.size) ||
      stamp(await handle.stat({ bigint: true })) !== stamp(before) ||
      stamp(await stat(filename)) !== stamp(before)
    )
      throw stale();
    await checkParents?.();
    const bytes = buffer.subarray(0, size);
    return { bytes, identity: `${stamp(before)}:${digest(bytes)}` };
  } finally {
    await handle.close();
  }
}
async function working(root: string, name: string) {
  // O_NOFOLLOW protects the leaf only. Keep every ancestor canonical and bound
  // to the same inode before/after opening and before returning any bytes.
  const parents: [string, string][] = [];
  const parentIdentity = async (directory: string) => {
    const info = await stat(directory);
    if (
      !info?.isDirectory() ||
      info.isSymbolicLink() ||
      (await fs.realpath(directory)) !== directory
    )
      throw stale();
    return `${info.dev}:${info.ino}:${info.mode}`;
  };
  const checkParents = async () => {
    for (const [directory, identity] of parents)
      if ((await parentIdentity(directory)) !== identity) throw stale();
  };
  parents.push([root, await parentIdentity(root)]);
  let current = root;
  const parts = gitFilePathSchema.parse(name).split("/");
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await stat(current);
    if (!info)
      return {
        value: { kind: "absent" } as GitConflictDocument["working"],
        identity: "missing",
      };
    if (i < parts.length - 1) {
      if (!info.isDirectory() || info.isSymbolicLink())
        throw Error("Небезопасный родитель пути конфликта Git.");
      parents.push([current, await parentIdentity(current)]);
      continue;
    }
    if (info.isSymbolicLink())
      return {
        value: {
          kind: "symlink",
          reason: "Символические ссылки не открываются.",
        } as GitConflictDocument["working"],
        identity: stamp(info),
      };
    if (!info.isFile() || info.size > BigInt(LIMIT) || info.nlink !== 1n)
      return {
        value: {
          kind: "unavailable",
          reason:
            "Тип или размер рабочего файла не поддерживается (предел 1 МиБ).",
        } as GitConflictDocument["working"],
        identity: stamp(info),
      };
  }
  const file = await regular(current, LIMIT, checkParents);
  if (!file) throw stale();
  const text = decode(file.bytes);
  return {
    value:
      text === null
        ? { kind: "binary" as const }
        : { kind: "text" as const, text },
    identity: file.identity,
  };
}
function decode(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
}
interface Stage {
  mode: string;
  oid: string;
}
function stages(raw: string, name: string): (Stage | null)[] {
  if (!raw || !raw.endsWith("\0") || Buffer.byteLength(raw) > 32768)
    throw invalid();
  const result: (Stage | null)[] = [null, null, null];
  for (const line of raw.slice(0, -1).split("\0")) {
    const row =
      /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([123])\t([\s\S]+)$/.exec(
        line,
      );
    if (!row || row[4] !== name || result[Number(row[3]) - 1]) throw invalid();
    result[Number(row[3]) - 1] = { mode: row[1], oid: row[2] };
  }
  return result;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

/** Map whole sections, not a first substring hit. Multiple feasible monotone matches
 * retain the exact payload but deliberately have no asserted source position. */
function sourceSections(
  input: string,
  sections: string[],
): GitConflictBlockSource[] {
  type Candidate = { from: number; to: number; text: string };
  let budget = 200000,
    scanBudget = 16 * LIMIT;
  const candidates = sections.map((section) => {
    if ((scanBudget -= input.length) < 0)
      throw new MappingUnavailable(
        "Слишком много диапазонов для безопасного сопоставления; доступен ручной выбор версии.",
      );
    const rows: Candidate[] = [];
    const add = (from: number, text: string) => {
      if (--budget < 0)
        throw new MappingUnavailable(
          "Слишком много неоднозначных диапазонов конфликта; доступен ручной выбор версии.",
        );
      rows.push({ from, to: from + text.length, text });
    };
    if (!section) {
      add(0, "");
      for (let i = 0; i < input.length; i++)
        if (input[i] === "\n") add(i + 1, "");
      if (input && !input.endsWith("\n")) add(input.length, "");
    } else {
      let from = 0;
      while ((from = input.indexOf(section, from)) >= 0) {
        if (from === 0 || input[from - 1] === "\n") add(from, section);
        from++;
      }
      // merge-file inserts LF or CRLF before a delimiter after an unterminated final line.
      if (!input.endsWith("\n") && section.endsWith("\n")) {
        for (const ending of ["\r\n", "\n"]) {
          if (!section.endsWith(ending)) continue;
          const exact = section.slice(0, -ending.length),
            from = input.length - exact.length;
          if (
            exact &&
            from >= 0 &&
            input.endsWith(exact) &&
            (from === 0 || input[from - 1] === "\n")
          )
            add(from, exact);
        }
      }
    }
    if (!rows.length) throw invalid();
    return rows;
  });
  const earliest = [0],
    latest = new Array<number>(sections.length + 1);
  latest[sections.length] = input.length;
  for (const rows of candidates) {
    const ends = rows
      .filter((row) => row.from >= earliest.at(-1)!)
      .map((row) => row.to);
    if (!ends.length) throw invalid();
    earliest.push(ends.reduce((a, b) => Math.min(a, b)));
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const starts = candidates[i]
      .filter((row) => row.to <= latest[i + 1])
      .map((row) => row.from);
    if (!starts.length) throw invalid();
    latest[i] = starts.reduce((a, b) => Math.max(a, b));
  }
  return candidates.map((rows, i) => {
    const feasible = rows.filter(
      (row) => row.from >= earliest[i] && row.to <= latest[i + 1],
    );
    if (!feasible.length) throw invalid();
    if (feasible.some((row) => row.text !== feasible[0].text))
      throw new MappingUnavailable(
        "Окончание строки блока неоднозначно; доступен ручной выбор версии.",
      );
    return {
      text: feasible[0].text,
      range:
        feasible.length === 1
          ? { from: feasible[0].from, to: feasible[0].to }
          : null,
    };
  });
}

async function generate(
  root: string,
  inputs: [string, string, string],
  git: (args: string[]) => Promise<{ stdout: string; stderr: string }>,
): Promise<GitConflictGenerated> {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const relative = path.relative(root, temporaryRoot);
  if (
    !relative ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
    throw Error(
      "Небезопасная временная папка: файлы слияния не могут создаваться внутри репозитория.",
    );
  const dir = await fs.mkdtemp(path.join(temporaryRoot, "goga-conflict-"));
  try {
    const files = ["base", "current", "incoming"].map((name) =>
      path.join(dir, name),
    );
    for (const [i, file] of files.entries())
      await fs.writeFile(file, inputs[i], { mode: 0o600, flag: "wx" });
    let label: string;
    do {
      label = `goga-${randomUUID()}`;
    } while (inputs.some((text) => text.includes(label)));
    const separators = new Set(
      inputs.flatMap((text) =>
        text
          .split("\n")
          .filter((line) => /^=+\r?$/.test(line))
          .map((line) => line.replace(/\r$/, "").length),
      ),
    );
    let size = 31;
    while (separators.has(size)) size++;
    const markers = [
      `${"<".repeat(size)} ${label}-current`,
      `${"|".repeat(size)} ${label}-base`,
      "=".repeat(size),
      `${">".repeat(size)} ${label}-incoming`,
    ];
    let output: { stdout: string; stderr: string },
      code = 0;
    try {
      output = await git([
        "merge-file",
        "--stdout",
        "--diff3",
        "--diff-algorithm=myers",
        `--marker-size=${size}`,
        "-q",
        "-L",
        `${label}-current`,
        "-L",
        `${label}-base`,
        "-L",
        `${label}-incoming`,
        "--",
        files[1],
        files[0],
        files[2],
      ]);
    } catch (error) {
      if (
        !(error instanceof CommandExitError) ||
        error.exitCode === null ||
        error.exitCode < 1 ||
        error.exitCode > 127
      )
        throw Error("Не удалось построить трёхстороннюю модель конфликта Git.");
      code = error.exitCode;
      output = { stdout: error.stdout, stderr: error.stderr };
    }
    if (
      output.stderr ||
      Buffer.byteLength(output.stdout) > LIMIT * 4 ||
      output.stdout.includes("\0")
    )
      throw invalid();
    const text = output.stdout;
    const parsed: {
      from: number;
      to: number;
      sections: [string, string, string];
    }[] = [];
    let offset = 0,
      state = -1,
      start = 0,
      sectionStart = 0,
      sections: [string, string, string] = ["", "", ""];
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const marker = markers.indexOf(line.replace(/\r?\n$/, ""));
      if (marker >= 0) {
        if (marker !== state + 1) throw invalid();
        if (marker === 0) {
          start = offset;
          sections = ["", "", ""];
        } else sections[state] = text.slice(sectionStart, offset);
        state = marker === 3 ? -1 : marker;
        sectionStart = offset + line.length;
        if (marker === 3)
          parsed.push({ from: start, to: sectionStart, sections });
      }
      offset += line.length;
    }
    if (state !== -1 || code !== Math.min(127, parsed.length)) throw invalid();
    const mapped = [
      sourceSections(
        inputs[0],
        parsed.map((row) => row.sections[1]),
      ),
      sourceSections(
        inputs[1],
        parsed.map((row) => row.sections[0]),
      ),
      sourceSections(
        inputs[2],
        parsed.map((row) => row.sections[2]),
      ),
    ];
    const blocks: GitConflictBlock[] = parsed.map((row, i) => ({
      id: digest(JSON.stringify([i, row.sections])),
      resultRange: { from: row.from, to: row.to },
      base: mapped[0][i],
      current: mapped[1][i],
      incoming: mapped[2][i],
    }));
    return { kind: "text", text, blocks, requiresExplicitReconstruction: true };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export class GitConflictReader {
  constructor(
    private readonly options: {
      context: <T>(
        scope: ScopeRef,
        fn: (context: GitConflictContext) => Promise<T>,
      ) => Promise<T>;
    },
  ) {}
  async read(input: GitConflictReadRequest): Promise<GitConflictDocument> {
    const request = gitConflictReadRequestSchema.parse(input);
    return this.options.context(request.scope, async (ctx) => {
      const root = ctx.root,
        owner = ctx.ownerKey;
      if (
        JSON.stringify(ctx.scope) !== JSON.stringify(request.scope) ||
        !path.isAbsolute(root) ||
        path.resolve(root) !== root
      )
        throw Error("Запрошен другой контекст конфликта Git.");
      await ctx.verify();
      const before = await ctx.snapshot();
      if (
        before.revision !== request.revision ||
        before.root !== root ||
        JSON.stringify(before.scope) !== JSON.stringify(request.scope)
      )
        throw stale();
      const entry = before.files.find((file) => file.path === request.path);
      if (!entry || entry.kind !== "conflict")
        throw Error("Файла нет в списке неразрешённых конфликтов Git.");
      const git = (args: string[]) =>
        ctx.git([
          ...safeArgs,
          `--git-dir=${path.join(root, ".git")}`,
          `--work-tree=${root}`,
          ...args,
        ]);
      const indexFile = path.join(root, ".git/index");
      const index = await regular(indexFile, 32 * LIMIT);
      if (!index) throw stale();
      const rows = stages(
        (
          await git([
            "ls-files",
            "--unmerged",
            "--stage",
            "-z",
            "--",
            request.path,
          ])
        ).stdout,
        request.path,
      );
      const readSource = async (
        row: Stage | null,
      ): Promise<GitConflictSource> => {
        if (!row) return { oid: null, mode: null, kind: "absent" };
        if (row.mode === "160000")
          return {
            ...row,
            kind: "submodule",
            reason: "Конфликт подмодуля требует отдельного разрешения.",
          };
        if (row.mode === "120000")
          return {
            ...row,
            kind: "symlink",
            reason:
              "Конфликт символической ссылки требует отдельного разрешения.",
          };
        const type = (await git(["cat-file", "-t", row.oid])).stdout;
        const size = (await git(["cat-file", "-s", row.oid])).stdout;
        if (type !== "blob\n" || !/^(0|[1-9]\d*)\n$/.test(size))
          throw invalid();
        if (Number(size) > LIMIT)
          return {
            ...row,
            kind: "unavailable",
            reason: "Версия файла превышает предел 1 МиБ.",
          };
        const text = (await git(["cat-file", "blob", row.oid])).stdout,
          bytes = Buffer.from(text);
        const hash = createHash(row.oid.length === 40 ? "sha1" : "sha256")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        if (hash !== row.oid) {
          // String-based runner cannot transport invalid UTF-8 exactly. Such blobs
          // are never made editable or passed into the three-way merge model.
          if (text.includes("\ufffd"))
            return {
              ...row,
              kind: "binary",
              reason: "Файл не является точным текстом UTF-8.",
            };
          throw invalid();
        }
        if (bytes.length !== Number(size)) throw invalid();
        return bytes.includes(0)
          ? { ...row, kind: "binary" }
          : { ...row, kind: "text", text };
      };
      const base = await readSource(rows[0]),
        current = await readSource(rows[1]),
        incoming = await readSource(rows[2]);
      const work = await working(root, request.path);
      let generated: GitConflictGenerated = {
        kind: "unavailable",
        reason:
          "Для этого типа конфликта требуется явный выбор версии или удаление; текстовые блоки недоступны.",
      };
      if (
        [base, current, incoming].every(
          (source) => source.kind === "text" || source.kind === "absent",
        ) &&
        current.kind !== "absent" &&
        incoming.kind !== "absent" &&
        !entry.originalPath &&
        (work.value.kind === "text" || work.value.kind === "absent")
      ) {
        try {
          generated = await generate(
            root,
            [base.text ?? "", current.text!, incoming.text!],
            git,
          );
        } catch (error) {
          if (!(error instanceof MappingUnavailable)) throw error;
          generated = { kind: "unavailable", reason: error.message };
        }
      }
      const afterWork = await working(root, request.path),
        afterIndex = await regular(indexFile, 32 * LIMIT);
      const after = await ctx.snapshot();
      await ctx.verify();
      if (
        after.revision !== request.revision ||
        after.root !== root ||
        ctx.root !== root ||
        ctx.ownerKey !== owner ||
        afterIndex?.identity !== index.identity ||
        afterWork.identity !== work.identity
      )
        throw stale();
      const fingerprint =
        // Only the host-proven operation binding can supply a save-state digest.
        // This digest is still not write authority: each save is admitted afresh.
        (work.value.kind === "text" || work.value.kind === "absent") &&
        (typeof ctx.scope === "string" ||
          after.branch === ctx.scope.branch ||
          ctx.stoppedRebase?.kind === "stopped-linear-rebase")
          ? await readGitConflictSaveFingerprint(ctx, request, {
              index: index.identity,
              work: work.identity,
              stages: rows,
              head: after.head,
              branch: after.branch,
              operation: after.operation,
            })
          : digest(
              JSON.stringify([
                owner,
                root,
                request.path,
                request.revision,
                rows,
                index.identity,
                work.identity,
              ]),
            );
      // Do not attach a new-state authority fingerprint to an old read document.
      await ctx.verify();
      if (
        (await regular(indexFile, 32 * LIMIT))?.identity !== index.identity ||
        (await working(root, request.path)).identity !== work.identity ||
        ctx.root !== root ||
        ctx.ownerKey !== owner
      )
        throw stale();
      return frozen({
        scope: request.scope,
        path: request.path,
        revision: request.revision,
        fingerprint,
        base,
        current,
        incoming,
        working: work.value,
        generated,
      });
    });
  }
}
