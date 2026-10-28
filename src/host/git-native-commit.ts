import type { NativeGitOperationResult } from "../shared/git-native-operation";
import {
  GitWorkspaceActions,
  type GitCommitContext,
} from "./git-workspace-actions";
import {
  gitCommitTokenSchema,
  type GitCommitRequest,
  type GitCommitResult,
} from "../shared/git-commit";
import { gitLiteralPaths } from "./git-native-client";
import { nativeGitGuard, nativeIntent } from "./git-native-context";
import {
  assertNativeGitState,
  assertNoNativeGitLocks,
  type NativeGitState,
} from "./git-native-state";
import { GitMergeSafety, type GitMergeContext } from "./git-merge-safety";
import {
  ByteCommandError,
  CommandExitError,
  type ByteCommandResult,
} from "./process";
import { NativeGitPreflightRejection } from "./git-native-journal";

const stale = () =>
  Error(
    "Состояние Git изменилось. Обновите список и подтвердите коммит заново.",
  );
const text = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function checked(r: ByteCommandResult) {
  if (!r.processSettled || r.signal !== null)
    throw new ByteCommandError(
      "process-unsettled",
      r.processSettled,
      r.stdout,
      r.stderr,
      r.exitCode,
      r.signal,
    );
  if (r.exitCode !== 0) throw stale();
  return text(r.stdout);
}
function rows(raw: string, tree = false) {
  const map = new Map<string, string>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const match = (
      tree
        ? /^(\d{6}) (?:blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/
        : /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/
    ).exec(row);
    if (!match || map.has(match[3])) throw stale();
    map.set(match[3], `${match[1]} ${match[2]}`);
  }
  return map;
}
function outside(map: Map<string, string>, selected: readonly string[]) {
  return JSON.stringify(
    [...map]
      .filter(([name]) => !selected.includes(name))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
class ConfigLease extends GitMergeSafety {
  run<T>(c: GitCommitContext, fn: () => Promise<T>) {
    const ctx: GitMergeContext = {
      ...c,
      git: (args, stdin) => c.git(args, { stdin }),
    };
    return this.withMetadataLock(ctx, "config.lock", fn);
  }
}
interface NativeTicket {
  token: string;
  intent: string;
  paths: string[];
  configuration: (readonly [string, string])[];
}
/** Native writer used by Host; the existing preview admission remains shared.
 * Git, not Desktop, owns the index/ref/reflog publication. Never falls back. */
export class NativeGitWorkspaceActions extends GitWorkspaceActions {
  private readonly nativeTickets = new Map<string, NativeTicket>();
  private readonly configLease = new ConfigLease();
  private async guard(
    c: GitCommitContext,
    n: Omit<NativeTicket, "token" | "intent">,
    selected: readonly string[],
  ) {
    return nativeGitGuard({
      root: c.root,
      capability: c.native,
      paths: n.paths,
      recoverIndex: true,
      configuration: n.configuration,
      verify: () => c.verify(),
      admittedStatus: async () => {
        // Between native commit and native index update a new file legitimately
        // has both a staged deletion and an untracked row. This is not a display
        // snapshot: preserve Git's raw public status instead of deduplicating it.
        const raw = await this.withPolicy(c, async (policy) => {
          const value = await policy.git([
            "status",
            "--porcelain=v2",
            "-z",
            "--branch",
            "--untracked-files=all",
          ]);
          await policy.verify();
          return value;
        });
        let headRef: string | null = null;
        try {
          headRef = (
            await this.git(c, [
              "symbolic-ref",
              "--quiet",
              "--no-recurse",
              "HEAD",
            ])
          ).stdout.trim();
        } catch (error) {
          if (!(error instanceof CommandExitError) || error.exitCode !== 1)
            throw error;
        }
        return { data: Buffer.from(raw), headRef };
      },
      policy: async () => {
        const config = (await this.git(c, ["config", "--null", "--list"]))
          .stdout;
        const attributes = (
          await this.git(c, ["check-attr", "-z", "--stdin", "--all"], [], {
            stdin: gitLiteralPaths(selected).toString("utf8"),
          })
        ).stdout;
        const flags = (await this.git(c, ["ls-files", "-v", "-z"])).stdout
          .split("\0")
          .filter((s) => s && !selected.includes(s.slice(2)));
        return nativeIntent([config, attributes, flags]);
      },
    });
  }
  override async prepare(input: GitCommitRequest) {
    const p = await super.prepare(input);
    try {
      await this.options.context(p.scope, async (c) => {
        const t = this.tickets.get(p.token)!;
        if (
          c.ownerKey !== t.ownerKey ||
          c.root !== p.root ||
          JSON.stringify(await this.capture(c, p.paths)) !==
            JSON.stringify(t.state)
        )
          throw stale();
        const s = await c.snapshot();
        const configuration = (
          await this.git(c, ["config", "--null", "--list"])
        ).stdout
          .split("\0")
          .filter(Boolean)
          .map((row) => {
            const i = row.indexOf("\n");
            return [
              i < 0 ? row : row.slice(0, i),
              i < 0 ? "" : row.slice(i + 1),
            ] as const;
          });
        const paths = [
          ...new Set([
            ...p.paths,
            ...s.files.flatMap((f) => [
              f.path,
              ...(f.originalPath ? [f.originalPath] : []),
            ]),
          ]),
        ].sort();
        const guard = await this.guard(c, { configuration, paths }, p.paths);
        const before = await guard.capture();
        // Do not let the extra native capture renew a stale confirmation.
        if (
          JSON.stringify(await this.capture(c, p.paths)) !==
          JSON.stringify(t.state)
        )
          throw stale();
        assertNativeGitState(before, await guard.capture());
        const intent = nativeIntent([
          "selected-commit",
          p.paths,
          p.message,
          p.author,
          p.committer,
          p.signing,
        ]);
        this.nativeTickets.set(p.token, {
          paths,
          configuration,
          intent,
          token: guard.journal.prepare("commit", before, intent),
        });
      });
      // Bound private tickets exactly like the shared preview cache.
      for (const token of this.nativeTickets.keys())
        if (!this.tickets.has(token)) this.nativeTickets.delete(token);
      return p;
    } catch (error) {
      this.tickets.delete(p.token);
      this.nativeTickets.delete(p.token);
      throw error;
    }
  }
  override async execute(input: string): Promise<GitCommitResult> {
    const token = gitCommitTokenSchema.parse(input),
      t = this.tickets.get(token),
      n = this.nativeTickets.get(token);
    this.tickets.delete(token);
    this.nativeTickets.delete(token);
    if (!t || !n || t.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    let finalize: (() => Promise<NativeGitOperationResult>) | undefined;
    let observed: GitCommitResult | undefined;
    const uncertain = (result: GitCommitResult): GitCommitResult => ({
      ...result,
      status: "uncertain",
      message:
        "Результат коммита требует проверки. Не повторяйте операцию; материалы восстановления сохранены.",
    });
    try {
      const response = await this.options.context(
        t.preview.scope,
        async (c) => {
          const p = t.preview;
          if (p.expiresAt <= this.now())
            throw Error("Подтверждение истекло. Подтвердите коммит заново.");
          if (
            c.root !== p.root ||
            c.ownerKey !== t.ownerKey ||
            JSON.stringify(c.scope) !== JSON.stringify(p.scope) ||
            p.expiresAt <= this.now() ||
            JSON.stringify(await this.capture(c, p.paths)) !==
              JSON.stringify(t.state)
          )
            throw stale();
          const guard = await this.guard(c, n, p.paths);
          const client = await c.native!.client([
            ...n.configuration,
            // Git may refresh unrelated entries. Never execute their external
            // filters; selected filter use was already refused by shared admission.
            ...n.configuration
              .filter(([key]) =>
                /^filter\..+\.(clean|smudge|process|required)$/i.test(key),
              )
              .map(
                ([key]) =>
                  [
                    key,
                    key.toLowerCase().endsWith(".required") ? "false" : "",
                  ] as const,
              ),
            ["i18n.logOutputEncoding", "UTF-8"],
            ["commit.status", "false"],
            ["commit.verbose", "false"],
            ["core.splitIndex", "false"],
            ["core.untrackedCache", "false"],
            ["submodule.recurse", "false"],
          ]);
          const read = async (
            command: "ls-tree" | "log" | "for-each-ref",
            args: string[],
          ) =>
            checked(await client.run({ policy: "local-read", command, args }));
          const treeBefore = t.state.head
            ? rows(
                await read("ls-tree", [
                  "-r",
                  "-z",
                  "--full-tree",
                  t.state.head,
                ]),
                true,
              )
            : new Map<string, string>();
          const refs = async () =>
            (
              await read("for-each-ref", [
                "--sort=refname",
                "--format=%(refname)%00%(objectname)%00%(symref)%00",
              ])
            )
              .split("\n")
              .filter(
                (row) =>
                  !t.state.reference ||
                  !row.startsWith(t.state.reference + "\0"),
              )
              .join("\n");
          const refsBefore = await refs();
          let log = "",
            indexPublished = false,
            verifiedCommit: string | undefined;
          const append = (r: ByteCommandResult) => {
            log += text(r.stdout) + text(r.stderr);
            return r;
          };
          const expectedEntry = (name: string) =>
            t.state.blobs[name] === null
              ? undefined
              : `${t.state.modes[name]} ${t.state.blobs[name]}`;
          const verifyCommit = async (
            before: NativeGitState,
            after: NativeGitState,
          ) => {
            if (!after.head || after.head === before.head) throw stale();
            const meta = (
              await read("log", [
                "-1",
                "--encoding=UTF-8",
                "--format=%P%x00%an <%ae>%x00%cn <%ce>%x00%B",
                "--no-show-signature",
                after.head,
              ])
            ).split("\0");
            if (
              meta.length !== 4 ||
              meta[0] !== (before.head ?? "") ||
              meta[1] !== p.author ||
              meta[2] !== p.committer ||
              meta[3] !== p.message.replace(/\n?$/, "\n") + "\n"
            )
              throw stale();
            const tree = rows(
              await read("ls-tree", ["-r", "-z", "--full-tree", after.head]),
              true,
            );
            if (outside(tree, p.paths) !== outside(treeBefore, p.paths))
              throw stale();
            for (const name of p.paths)
              if (tree.get(name) !== expectedEntry(name)) throw stale();
          };
          const result = await guard.journal.execute({
            token: n.token,
            operation: "commit",
            deferRecoveryCleanup: (finish) => {
              finalize = finish;
            },
            intentFingerprint: n.intent,
            capture: guard.capture,
            run: (confirmed) =>
              this.configLease
                .run(c, async () => {
                  if (p.expiresAt <= this.now())
                    throw new NativeGitPreflightRejection(
                      "Подтверждение коммита истекло.",
                    );
                  if (
                    JSON.stringify(await this.capture(c, p.paths)) !==
                    JSON.stringify(t.state)
                  )
                    throw new NativeGitPreflightRejection(
                      "Предпросмотр коммита устарел.",
                    );
                  assertNativeGitState(confirmed, await guard.capture());
                  return client.inTemporaryIndex(async (indexed) => {
                    // A detached private HEAD gives native commit the approved parent.
                    // No source ref/index is touched by preparation or signing.
                    if (confirmed.head)
                      checked(
                        await indexed.run({
                          policy: "local-write",
                          command: "update-ref",
                          args: ["--no-deref", "HEAD", confirmed.head],
                        }),
                      );
                    const seeded = append(
                      await indexed.run({
                        policy: "local-write",
                        command: "read-tree",
                        args: confirmed.head ? [confirmed.head] : ["--empty"],
                      }),
                    );
                    if (
                      seeded.exitCode !== 0 ||
                      !seeded.processSettled ||
                      seeded.signal !== null
                    )
                      return seeded;
                    const added = append(
                      await indexed.run({
                        policy: "local-write",
                        command: "add",
                        args: [
                          "--all",
                          "--pathspec-from-file=-",
                          "--pathspec-file-nul",
                        ],
                        stdin: gitLiteralPaths(p.paths),
                      }),
                    );
                    if (
                      added.exitCode !== 0 ||
                      !added.processSettled ||
                      added.signal !== null
                    )
                      return added;
                    const prepared = rows(
                      checked(
                        await indexed.run({
                          policy: "local-read",
                          command: "ls-files",
                          args: ["--stage", "-z"],
                        }),
                      ),
                    );
                    if (
                      outside(prepared, p.paths) !==
                      outside(treeBefore, p.paths)
                    )
                      throw stale();
                    for (const name of p.paths) {
                      const blob = prepared.get(name)?.split(" ")[1] ?? null;
                      if (blob !== t.state.blobs[name]) throw stale();
                    }
                    // Public index-info preserves an explicitly staged executable bit
                    // even when native commit --only would take its mode from HEAD.
                    const zero = "0".repeat(
                      t.state.head?.length ??
                        Object.values(t.state.blobs).find(Boolean)?.length ??
                        40,
                    );
                    const indexInfo = Buffer.from(
                      p.paths
                        .map((name) =>
                          t.state.blobs[name] === null
                            ? `0 ${zero}\t${name}\0`
                            : `${t.state.modes[name]} ${t.state.blobs[name]} 0\t${name}\0`,
                        )
                        .join(""),
                    );
                    const mode = append(
                      await indexed.run({
                        policy: "local-write",
                        command: "update-index",
                        args: ["-z", "--index-info"],
                        stdin: indexInfo,
                      }),
                    );
                    if (
                      mode.exitCode !== 0 ||
                      !mode.processSettled ||
                      mode.signal !== null
                    )
                      return mode;
                    const ready = rows(
                      checked(
                        await indexed.run({
                          policy: "local-read",
                          command: "ls-files",
                          args: ["--stage", "-z"],
                        }),
                      ),
                    );
                    if (
                      outside(ready, p.paths) !== outside(treeBefore, p.paths)
                    )
                      throw stale();
                    for (const name of p.paths)
                      if (ready.get(name) !== expectedEntry(name))
                        throw stale();
                    // No source index write has happened. Revalidate user bytes and
                    // authority after preparation, immediately before native commit.
                    assertNativeGitState(confirmed, await guard.capture());
                    if (p.expiresAt <= this.now()) throw stale();
                    const committed = append(
                      await indexed.run({
                        policy: "local-write",
                        command: "commit",
                        args: [
                          "--no-edit",
                          "--cleanup=verbatim",
                          ...(p.signing ? ["--gpg-sign"] : ["--no-gpg-sign"]),
                          "--message",
                          p.message,
                        ],
                      }),
                    );
                    if (
                      committed.exitCode !== 0 ||
                      !committed.processSettled ||
                      committed.signal !== null
                    )
                      return committed;
                    const commit = checked(
                      await indexed.run({
                        policy: "local-read",
                        command: "rev-parse",
                        args: ["--verify", "HEAD"],
                      }),
                    ).trim();
                    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
                      throw stale();
                    // Inspect the native commit before publishing its reference.
                    await verifyCommit(confirmed, {
                      ...confirmed,
                      head: commit,
                    });
                    assertNativeGitState(confirmed, await guard.capture());
                    const published = append(
                      await client.run({
                        policy: "local-write",
                        command: "update-ref",
                        args: [
                          "-m",
                          "commit: " + p.message.split("\n")[0],
                          "--stdin",
                        ],
                        stdin: Buffer.from(
                          `start\nupdate HEAD ${commit} ${confirmed.head ?? zero}\nprepare\n`,
                        ),
                        verifyPrepared: async (assertActive) => {
                          // Native Git holds HEAD and its resolved ref. Check both
                          // direct/recursive identities before authorizing commit.
                          const prepared = await this.capture(c, p.paths);
                          // Display revision includes Git's newly held ref locks;
                          // compare every authority/data field, not that UI token.
                          if (
                            JSON.stringify({
                              ...prepared,
                              revision: t.state.revision,
                            }) !== JSON.stringify(t.state)
                          )
                            throw stale();
                          assertNativeGitState(
                            confirmed,
                            await guard.capture(),
                          );
                          if (p.expiresAt <= this.now()) throw stale();
                          assertActive();
                        },
                      }),
                    );
                    if (
                      published.exitCode !== 0 ||
                      !published.processSettled ||
                      published.signal !== null
                    )
                      return published;
                    if (published.stderr.length) throw stale();
                    const afterCommit = await guard.capture();
                    this.assertPreserved(confirmed, afterCommit, p.paths);
                    // Never overwrite a foreign index edit in the ref/index gap.
                    if (
                      afterCommit.index !== confirmed.index ||
                      afterCommit.headRef !== confirmed.headRef ||
                      afterCommit.policyFingerprint !==
                        confirmed.policyFingerprint ||
                      JSON.stringify(afterCommit.owner) !==
                        JSON.stringify(confirmed.owner) ||
                      (await refs()) !== refsBefore
                    )
                      throw stale();
                    await verifyCommit(confirmed, afterCommit);
                    assertNativeGitState(afterCommit, await guard.capture());
                    // Git itself applies only the selected entries to the real index.
                    // A failure here retains recovery; no rollback or second attempt.
                    return append(
                      await client.run({
                        policy: "local-write",
                        command: "update-ref",
                        args: ["--stdin"],
                        stdin: Buffer.from(
                          `start\nverify HEAD ${afterCommit.head}\nprepare\n`,
                        ),
                        verifyPrepared: async (assertActive) => {
                          assertNativeGitState(
                            afterCommit,
                            await guard.capture(),
                          );
                          if (p.expiresAt <= this.now()) throw stale();
                          assertActive();
                          const indexed = append(
                            await client.run({
                              policy: "local-write",
                              command: "update-index",
                              args: ["-z", "--index-info"],
                              stdin: indexInfo,
                            }),
                          );
                          if (
                            indexed.exitCode !== 0 ||
                            !indexed.processSettled ||
                            indexed.signal !== null
                          ) {
                            throw new ByteCommandError(
                              "verification",
                              indexed.processSettled,
                              indexed.stdout,
                              indexed.stderr,
                              indexed.exitCode,
                              indexed.signal,
                            );
                          }
                          indexPublished = true;
                          if (indexed.stderr.length) throw stale();
                          assertActive();
                        },
                      }),
                    );
                  }, true);
                })
                .catch((error) => {
                  if (error instanceof ByteCommandError)
                    log += text(error.stdout) + text(error.stderr);
                  throw error;
                }),
            verify: async (before, after, command) => {
              if (command.exitCode === 0 && command.stderr.length)
                throw stale();
              await assertNoNativeGitLocks(c.root);
              this.assertPreserved(before, after, p.paths);
              if (
                after.headRef !== before.headRef ||
                (await refs()) !== refsBefore
              )
                throw stale();
              if (command.signal !== null) throw stale();
              if (command.exitCode !== 0) {
                assertNativeGitState(before, after);
                return {
                  outcome: "rejected",
                  afterHead: after.head,
                  conflicts: [],
                  verifiedUnrelatedData: true,
                };
              }
              await verifyCommit(before, after);
              const index = rows(text(Buffer.from(after.indexData, "base64")));
              for (const name of p.paths)
                if (index.get(name) !== expectedEntry(name)) throw stale();
              const observed = await c.snapshot();
              if (
                observed.operation !== "none" ||
                observed.files.some(
                  (f) => f.kind === "conflict" || !n.paths.includes(f.path),
                )
              )
                throw stale();
              // All read-back probes must leave the same observed result in place.
              assertNativeGitState(after, await guard.capture());
              verifiedCommit = after.head!;
              return {
                outcome: "completed",
                afterHead: after.head,
                conflicts: [],
                verifiedUnrelatedData: true,
              };
            },
          });
          const success = result.outcome === "completed";
          return (observed = {
            scope: p.scope,
            status: success
              ? "committed"
              : result.outcome === "rejected"
                ? "not-committed"
                : "uncertain",
            indexPublished,
            ...(success && verifiedCommit ? { commit: verifiedCommit } : {}),
            ...(result.recoveryPath
              ? { recoveryPath: result.recoveryPath }
              : {}),
            log,
            message: success
              ? "Локальный коммит создан. Остальные подготовленные изменения сохранены."
              : result.outcome === "rejected"
                ? "Git не создал коммит. Исходные данные и индекс проверены и сохранены."
                : "Результат коммита требует проверки. Не повторяйте операцию; материалы восстановления сохранены.",
          });
        },
      );
      if (finalize) {
        const finished = await finalize();
        if (finished.recovery !== "removed" || finished.outcome === "uncertain")
          return uncertain(response);
        delete response.recoveryPath;
      }
      return response;
    } catch (error) {
      if (!observed) throw error;
      // A throwing outer context did not return its sanitized copy. Preserve
      // publication/recovery facts, never raw child output or cleanup errors.
      return uncertain({
        ...observed,
        log: "Завершающая проверка коммита или освобождение контекста завершились ошибкой. Диагностика окружения скрыта.",
      });
    }
  }
  private assertPreserved(
    before: NativeGitState,
    after: NativeGitState,
    selected: readonly string[],
  ) {
    if (
      JSON.stringify(before.files) !== JSON.stringify(after.files) ||
      outside(rows(text(Buffer.from(before.indexData, "base64"))), selected) !==
        outside(rows(text(Buffer.from(after.indexData, "base64"))), selected)
    )
      throw stale();
  }
}
