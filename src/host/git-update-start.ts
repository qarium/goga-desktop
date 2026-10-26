import {
  constants,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  fstatSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type {
  GitUpdateHandoffCandidate,
  GitUpdateHandoffResult,
} from "../shared/git-update-handoff";
import type { GitUpdateHandoffContext } from "./git-update-handoff";
import { directory, regular, stat, hash } from "./git-conflict-state";
import {
  raw,
  rawKey,
  readTree,
  run,
  args,
} from "./git-rebase-operations-state";
import { continuationPolicy, sourceCommit } from "./git-rebase-continue-state";
import { readRebaseBinding } from "./git-rebase-read-binding";
import { CommandExitError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";

/** Host-only evidence. Neither index contents nor replay commands are IPC input. */
export interface UpdateStartProof {
  algorithm: "merge" | "rebase";
  conflicts: string[];
  expectedIndex: string;
  prefix: { source: string; tree: string; author: string; message: string }[];
  stopped: string | null;
  paths: string[];
  picks: string[];
  worktree: Record<string, { mode: string; bytes: Buffer }>;
}
const stale = () =>
  Error(
    "Подтверждение ручного обновления устарело; повторно проверьте контекст.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Native START, like the existing native merge start. Git owns HEAD/index and
 * current-ref transactions; Desktop locks config and the pinned source. No
 * force, rollback, retry or publication. Portable Node cannot make arbitrary
 * same-user writes atomic with a child; every detected ambiguity is uncertain. */
export async function startGitUpdate(
  c: GitUpdateHandoffContext,
  candidate: GitUpdateHandoffCandidate,
  proof: UpdateStartProof,
  revalidate: () => Promise<void>,
): Promise<GitUpdateHandoffResult> {
  const root = c.root,
    owner = c.ownerKey,
    scope = structuredClone(c.scope);
  const gd = path.join(root, ".git");
  const locks = new Map<string, string>();
  let attempted = false;
  const lines: string[] = [];
  const result = (
    status: GitUpdateHandoffResult["status"],
    message: string,
  ): GitUpdateHandoffResult => ({
    scope,
    root,
    algorithm: candidate.algorithm,
    status,
    changed: attempted,
    conflicts: status === "conflict" ? [...proof.conflicts] : [],
    message,
    log: sanitizeRepositoryLog(lines.join("\n")),
  });
  const assertOwner = () => {
    c.assertPublicationOwner?.();
    if (c.ownerKey !== owner || c.root !== root || !equal(c.scope, scope))
      throw stale();
  };
  const checkLocks = () => {
    for (const [name, identity] of locks)
      if (regular(path.join(gd, name))?.identity !== identity) throw stale();
  };
  const lock = (name: string) => {
    const filename = path.join(gd, name);
    directory(path.dirname(filename));
    const fd = openSync(
      filename,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const descriptorIdentity = () => {
      const s = fstatSync(fd, { bigint: true });
      return `${[s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":")}:${hash(Buffer.alloc(0))}`;
    };
    locks.set(name, descriptorIdentity());
    try {
      writeFileSync(fd, "");
      fsyncSync(fd);
      locks.set(name, regular(filename)!.identity);
    } finally {
      try {
        locks.set(name, descriptorIdentity());
      } finally {
        closeSync(fd);
      }
    }
  };
  let outcome: GitUpdateHandoffResult | undefined;
  let beforeStartError: unknown;
  try {
    // Establish immutable owner pins before any asynchronous capability probe.
    assertOwner();
    // Check capabilities without starting the operation; never retry after a
    // native refusal with fewer safety options.
    let help = "";
    try {
      help = await run(c, [candidate.algorithm, "-h"]);
    } catch (e) {
      if (!(e instanceof CommandExitError) || e.exitCode !== 129) throw e;
      help = e.stdout + e.stderr;
    }
    help = help.replaceAll("[no-]", "");
    const required =
      candidate.algorithm === "merge"
        ? ["--overwrite-ignore", "--autostash", "--strategy"]
        : [
            "--update-refs",
            "--rebase-merges",
            "--fork-point",
            "--autostash",
            "--merge",
          ];
    if (required.some((flag) => !help.includes(flag)))
      throw Error(
        "Git не поддерживает необходимые безопасные параметры ручного обновления.",
      );
    const policy = await continuationPolicy(c);
    const tree = await readTree(c, candidate.targetHead);
    const before = raw(root);
    // Rebase can overwrite ignored files. Refuse an occupied untracked
    // destination anywhere in the complete replay envelope, including parents.
    for (const name of Object.keys(before.files).filter(
      (name) => !tree[name],
    )) {
      if (
        proof.paths.some(
          (p) =>
            p === name || p.startsWith(`${name}/`) || name.startsWith(`${p}/`),
        )
      )
        throw Error(
          "Файл вне Git занимает путь обновления; ручная операция не начата.",
        );
    }
    for (const name of [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
      `${candidate.sourceRef}.lock`,
      `refs/heads/${candidate.targetBranch}.lock`,
    ])
      if (stat(path.join(gd, name)))
        throw Error("Репозиторий занят другой операцией Git.");
    await revalidate();
    if (rawKey(raw(root)) !== rawKey(before)) throw stale();
    lock("config.lock");
    lock(`${candidate.sourceRef}.lock`);
    await c.verifyOwner();
    const checkedPolicy = await continuationPolicy(c);
    if (
      checkedPolicy.policy !== policy.policy ||
      checkedPolicy.committer !== policy.committer
    )
      throw stale();
    checkLocks();
    assertOwner();
    if (rawKey(raw(root, [...locks.keys()])) !== rawKey(before)) throw stale();
    const identity = /^(.+) <([^<>]+)>$/.exec(policy.committer)!;
    const command =
      candidate.algorithm === "merge"
        ? [
            "-c",
            `branch.${candidate.targetBranch}.mergeOptions=`,
            "-c",
            "merge.autoStash=false",
            "merge",
            "--ff",
            "--commit",
            "--no-edit",
            "--no-squash",
            "--no-autostash",
            "--no-overwrite-ignore",
            "--no-verify-signatures",
            "--no-stat",
            "--strategy=ort",
            "--",
            candidate.sourceOid,
          ]
        : [
            "rebase",
            "--merge",
            "--no-autostash",
            "--no-update-refs",
            "--no-fork-point",
            "--no-rebase-merges",
            "--no-verify",
            candidate.sourceOid,
          ];
    let failure: unknown;
    attempted = true;
    try {
      const o = await c.isolatedGit(
        args(root, [
          "-c",
          "commit.gpgsign=false",
          "-c",
          `user.name=${identity[1]}`,
          "-c",
          `user.email=${identity[2]}`,
          "-c",
          "rebase.rescheduleFailedExec=false",
          ...command,
        ]),
      );
      lines.push(o.stdout, o.stderr);
    } catch (e) {
      failure = e;
      if (e instanceof CommandExitError) lines.push(e.stdout, e.stderr);
    }
    // Timeouts, cancellation and transport failures do not prove a native stop.
    if (!(failure instanceof CommandExitError) || failure.exitCode !== 1)
      throw Error("Git не подтвердил ожидаемую остановку на конфликте.");
    checkLocks();
    assertOwner();
    const after = raw(root, [...locks.keys()]);
    if ((await run(c, ["ls-files", "--stage", "-z"])) !== proof.expectedIndex)
      throw stale();
    if (
      (
        await run(c, ["show-ref", "--verify", "--hash", candidate.sourceRef])
      ).trim() !== candidate.sourceOid
    )
      throw stale();
    const text = (name: string) =>
      regular(path.join(gd, name))?.bytes.toString("utf8");
    if (text("ORIG_HEAD") !== `${candidate.targetHead}\n`) throw stale();
    if (candidate.algorithm === "merge") {
      if (
        text("MERGE_HEAD") !== `${candidate.sourceOid}\n` ||
        text("HEAD") !== `ref: refs/heads/${candidate.targetBranch}\n` ||
        (await run(c, ["rev-parse", "HEAD"])).trim() !== candidate.targetHead
      )
        throw stale();
      if (
        [
          "rebase-merge",
          "rebase-apply",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "sequencer",
          "BISECT_START",
          "MERGE_AUTOSTASH",
        ].some((n) => stat(path.join(gd, n)))
      )
        throw stale();
      await c.verifyOwner();
    } else {
      if (
        text("rebase-merge/orig-head") !== `${candidate.targetHead}\n` ||
        text("rebase-merge/onto") !== `${candidate.sourceOid}\n` ||
        text("REBASE_HEAD") !== `${proof.stopped}\n`
      )
        throw stale();
      const commands = (name: string) => {
        const value = text(`rebase-merge/${name}`);
        if (value === undefined) throw stale();
        return value
          .split("\n")
          .filter((l) => l && !l.startsWith("#"))
          .map((l) => {
            const m = /^pick ([a-f0-9]{40})(?: .*)?$/.exec(l);
            if (!m) throw stale();
            return m[1];
          });
      };
      const position = proof.prefix.length + 1;
      if (
        !equal(commands("done"), proof.picks.slice(0, position)) ||
        !equal(commands("git-rebase-todo"), proof.picks.slice(position)) ||
        text("rebase-merge/msgnum") !== `${position}\n` ||
        text("rebase-merge/end") !== `${proof.picks.length}\n`
      )
        throw stale();
      await readRebaseBinding(
        { path: root, gitCommonDir: gd, branch: candidate.targetBranch },
        (a) => run(c, a),
      );
      let head = (await run(c, ["rev-parse", "HEAD"])).trim();
      for (const expected of [...proof.prefix].reverse()) {
        const commit = await sourceCommit(c, head);
        if (
          commit.author !== expected.author ||
          commit.message !== expected.message ||
          (await run(c, ["rev-parse", `${head}^{tree}`])).trim() !==
            expected.tree
        )
          throw stale();
        head = commit.parent;
      }
      if (head !== candidate.sourceOid) throw stale();
      await (c.verifyNextRebase ?? c.verifyOwner)();
    }
    // Verify all materialized bytes/modes, not merely index stages. Outside
    // the proven trees, ignored/untracked data retains its physical identity.
    for (const name of proof.paths) {
      const expected = proof.worktree[name],
        actual = after.files[name];
      if (!expected) {
        if (actual) throw stale();
        continue;
      }
      if (
        !actual ||
        !actual.bytes.equals(expected.bytes) ||
        (actual.mode & 0o111 ? "100755" : "100644") !== expected.mode
      )
        throw stale();
    }
    for (const [name, file] of Object.entries(before.files))
      if (
        !proof.paths.includes(name) &&
        after.files[name]?.identity !== file.identity
      )
        throw stale();
    checkLocks();
    assertOwner();
    if (rawKey(raw(root, [...locks.keys()])) !== rawKey(after)) throw stale();
    outcome = result(
      "conflict",
      "Ручное обновление остановлено на проверенном конфликте. Разрешите конфликты или отдельно подтвердите отмену. Публикация не выполнялась.",
    );
  } catch (e) {
    if (!attempted) beforeStartError = e;
    lines.push(
      e instanceof Error ? e.message : "Не удалось проверить результат Git.",
    );
    if (attempted)
      outcome = result(
        "uncertain",
        "Результат ручного обновления не подтверждён. Проверьте состояние Git и журнал; автоматической отмены и повтора нет.",
      );
  } finally {
    const errors: string[] = [];
    for (const [name, id] of [...locks].reverse()) {
      try {
        if (regular(path.join(gd, name))?.identity !== id) throw stale();
        unlinkSync(path.join(gd, name));
      } catch {
        errors.push(name);
      }
    }
    if (errors.length) {
      lines.push(
        `Не удалось подтвердить снятие блокировок: ${errors.join(", ")}`,
      );
      outcome = result(
        "uncertain",
        "Не удалось подтвердить освобождение Git. Проверьте состояние и журнал; автоматический повтор отключён.",
      );
    }
  }
  if (!outcome) throw beforeStartError;
  return outcome;
}
