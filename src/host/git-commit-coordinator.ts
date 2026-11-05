import type { NativeGitOperationResult } from "../shared/git-native-operation";
import {
  gitCommitRequestSchema,
  gitCommitTokenSchema,
  type GitCommitRequest,
  type GitCommitResult,
} from "../shared/git-commit";
import {
  GitWorkspaceActions,
  type GitCommitContext,
} from "./git-workspace-actions";
import { withPrivateGitRead } from "./git-private-read";
import { withGitPolicyCaptureScope } from "./git-private-read-scope";
import {
  CommitProofReader,
  commitOwnerIdentity,
  commitEntries,
  commitOutside,
  type CommitBaseline,
  type CommitPhase,
} from "./git-commit-proof";
import { GitMergeSafety, type GitMergeContext } from "./git-merge-safety";
import { gitLiteralPaths, type NativeGitClient } from "./git-native-client";
import { nativeIntent } from "./git-native-context";
import { nativeGitPhysicalIdentity } from "./git-native-state";
import { ByteCommandError, type ByteCommandResult } from "./process";

const stale = () =>
  Error("Состояние Git изменилось. Подтвердите коммит заново.");
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
const failed = (r: ByteCommandResult) =>
  r.exitCode !== 0 || !r.processSettled || r.signal !== null;
class CommitConfigLease extends GitMergeSafety {
  run<T>(context: GitCommitContext, action: () => Promise<T>) {
    const c: GitMergeContext = {
      ...context,
      git: (args, stdin) => context.git(args, { stdin }),
    };
    return this.withMetadataLock(c, "config.lock", action);
  }
}
interface CoordinatorTicket {
  token: string;
  intent: string;
  paths: readonly string[];
  configuration: readonly (readonly [string, string])[];
  baseline: CommitBaseline;
}
/** Host selected-file commit route. Uses native Git for every
 * mutation and the existing journal lifecycle; never retries or rolls back. */
export class GitCommitCoordinator extends GitWorkspaceActions {
  private readonly nativeTickets = new Map<string, CoordinatorTicket>();
  private readonly lease = new CommitConfigLease();
  private proofReader(
    c: GitCommitContext,
    client: NativeGitClient,
    paths: readonly string[],
  ) {
    return new CommitProofReader({
      context: c,
      client,
      paths,
      sourceGit: async (args) => (await this.git(c, args)).stdout,
      privateRead: (read) =>
        withPrivateGitRead(
          c.root,
          [],
          async (args) => (await this.git(c, args)).stdout,
          async (args) => (await this.git(c, args)).stdout,
          read,
          { commitSourcePaths: paths },
        ),
    });
  }
  override async prepare(input: GitCommitRequest) {
    const request = gitCommitRequestSchema.parse(input);
    return this.options.context(request.scope, async (c) => {
      if (!c.native) throw stale();
      const p = await this.prepareInContext(request, c);
      try {
        const ticket = this.tickets.get(p.token)!;
        const snapshot = await c.snapshot();
        const paths = [
          ...new Set([
            ...p.paths,
            ...snapshot.files.flatMap((file) => [
              file.path,
              ...(file.originalPath ? [file.originalPath] : []),
            ]),
          ]),
        ].sort();
        const configuration = (
          await withGitPolicyCaptureScope(() =>
            this.git(c, ["config", "--null", "--list", "--includes"]),
          )
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
        const reader = this.proofReader(
          c,
          await c.native.client(configuration),
          paths,
        );
        const baseline = await reader.captureBaseline(p, ticket.state);
        if (
          JSON.stringify(await this.capture(c, p.paths)) !==
          JSON.stringify(ticket.state)
        )
          throw stale();
        await reader.closeBaseline(baseline);
        const intent = nativeIntent([
          "selected-commit",
          p.paths,
          p.message,
          p.author,
          p.committer,
          p.signing,
        ]);
        this.nativeTickets.set(p.token, {
          token: c.native.journal.prepare("commit", baseline.recovery, intent),
          intent,
          paths,
          configuration,
          baseline,
        });
        for (const token of this.nativeTickets.keys())
          if (!this.tickets.has(token)) this.nativeTickets.delete(token);
        return p;
      } catch (error) {
        this.tickets.delete(p.token);
        this.nativeTickets.delete(p.token);
        throw error;
      }
    });
  }
  override async execute(input: string): Promise<GitCommitResult> {
    const token = gitCommitTokenSchema.parse(input),
      ticket = this.tickets.get(token),
      native = this.nativeTickets.get(token);
    this.tickets.delete(token);
    this.nativeTickets.delete(token);
    if (!ticket || !native || ticket.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    let finalize: (() => Promise<NativeGitOperationResult>) | undefined,
      observed: GitCommitResult | undefined;
    const uncertain = (result: GitCommitResult): GitCommitResult => ({
      ...result,
      status: "uncertain",
      message:
        "Результат коммита требует проверки. Не повторяйте операцию; материалы восстановления сохранены.",
    });
    try {
      const response = await this.options.context(
        ticket.preview.scope,
        async (c) => {
          const p = ticket.preview,
            b = native.baseline;
          const active = () => {
            if (p.expiresAt <= this.now()) throw stale();
          };
          active();
          if (
            !c.native ||
            c.root !== p.root ||
            c.ownerKey !== ticket.ownerKey ||
            JSON.stringify(c.scope) !== JSON.stringify(p.scope)
          )
            throw stale();
          const client = await c.native.client([
            ...native.configuration,
            ...native.configuration
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
          const reader = this.proofReader(c, client, native.paths);
          let candidate: string | null = null,
            indexPublished = false,
            log = "";
          const append = (r: ByteCommandResult) => {
            log += text(r.stdout) + text(r.stderr);
            return r;
          };
          const entry = (name: string) =>
            ticket.state.blobs[name] === null
              ? undefined
              : `${ticket.state.modes[name]} ${ticket.state.blobs[name]}`;
          const read = async (command: "log" | "ls-tree", args: string[]) =>
            checked(await client.run({ policy: "local-read", command, args }));
          const verifyCommit = async () => {
            if (!candidate || candidate === b.recovery.head) throw stale();
            const meta = (
              await read("log", [
                "-1",
                "--encoding=UTF-8",
                "--format=%P%x00%an <%ae>%x00%cn <%ce>%x00%B",
                "--no-show-signature",
                candidate,
              ])
            ).split("\0");
            if (
              meta.length !== 4 ||
              meta[0] !== (b.recovery.head ?? "") ||
              meta[1] !== p.author ||
              meta[2] !== p.committer ||
              meta[3] !== p.message.replace(/\n?$/, "\n") + "\n"
            )
              throw stale();
            const tree = commitEntries(
              await read("ls-tree", ["-r", "-z", "--full-tree", candidate]),
              true,
            );
            if (
              commitOutside(tree, p.paths) !==
              commitOutside(reader.originalHeadTree(), p.paths)
            )
              throw stale();
            for (const name of p.paths)
              if (tree.get(name) !== entry(name)) throw stale();
          };
          const prove = (phase: CommitPhase, readback?: () => Promise<void>) =>
            reader.prove(
              {
                phase,
                baseline: b,
                candidate: [
                  "publish-prepared",
                  "index-prepared",
                  "result",
                ].includes(phase)
                  ? candidate
                  : null,
                index: indexPublished ? "selected-published" : "original",
              },
              readback,
            );
          const result = await c.native.journal.executeCommit({
            token: native.token,
            intentFingerprint: native.intent,
            deferRecoveryCleanup: (finish) => {
              finalize = finish;
            },
            proveBefore: async (phase) => {
              active();
              return prove(phase);
            },
            attemptScope: async (action) => {
              const owner = await c.native!.owner(),
                physical = await nativeGitPhysicalIdentity(c.root);
              if (
                commitOwnerIdentity(owner) !==
                  commitOwnerIdentity(b.recovery.owner) ||
                physical.physicalRoot !== b.recovery.physicalRoot ||
                physical.physicalGit !== b.recovery.physicalGit
              )
                throw stale();
              return this.lease.run(c, action);
            },
            run: async () => {
              try {
                return await client.inTemporaryIndex(async (indexed) => {
                  if (b.recovery.head)
                    checked(
                      await indexed.run({
                        policy: "local-write",
                        command: "update-ref",
                        args: ["--no-deref", "HEAD", b.recovery.head],
                      }),
                    );
                  const seeded = append(
                    await indexed.run({
                      policy: "local-write",
                      command: "read-tree",
                      args: b.recovery.head ? [b.recovery.head] : ["--empty"],
                    }),
                  );
                  if (failed(seeded)) return seeded;
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
                  if (failed(added)) return added;
                  const prepared = commitEntries(
                    checked(
                      await indexed.run({
                        policy: "local-read",
                        command: "ls-files",
                        args: ["--stage", "-z"],
                      }),
                    ),
                  );
                  if (
                    commitOutside(prepared, p.paths) !==
                    commitOutside(reader.originalHeadTree(), p.paths)
                  )
                    throw stale();
                  for (const name of p.paths)
                    if (
                      (prepared.get(name)?.split(" ")[1] ?? null) !==
                      ticket.state.blobs[name]
                    )
                      throw stale();
                  const zero = "0".repeat(
                    ticket.state.head?.length ??
                      Object.values(ticket.state.blobs).find(Boolean)?.length ??
                      40,
                  );
                  const indexInfo = Buffer.from(
                    p.paths
                      .map((name) =>
                        ticket.state.blobs[name] === null
                          ? `0 ${zero}\t${name}\0`
                          : `${ticket.state.modes[name]} ${ticket.state.blobs[name]} 0\t${name}\0`,
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
                  if (failed(mode)) return mode;
                  const readyResult = await indexed.run({
                    policy: "local-read",
                    command: "ls-files",
                    args: ["--stage", "-z"],
                  });
                  const ready = commitEntries(checked(readyResult));
                  if (
                    commitOutside(ready, p.paths) !==
                    commitOutside(reader.originalHeadTree(), p.paths)
                  )
                    throw stale();
                  for (const name of p.paths)
                    if (ready.get(name) !== entry(name)) throw stale();
                  await prove("before-commit");
                  active();
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
                  if (failed(committed)) return committed;
                  candidate = checked(
                    await indexed.run({
                      policy: "local-read",
                      command: "rev-parse",
                      args: ["--verify", "HEAD"],
                    }),
                  ).trim();
                  await reader.setCandidateObjects(
                    candidate,
                    readyResult.stdout,
                    p.paths,
                  );
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
                        `start\nupdate HEAD ${candidate} ${b.recovery.head ?? zero}\nprepare\n`,
                      ),
                      verifyPrepared: async (assertActive) => {
                        await prove("publish-prepared", verifyCommit);
                        active();
                        assertActive();
                      },
                    }),
                  );
                  if (failed(published)) return published;
                  if (published.stderr.length) throw stale();
                  return append(
                    await client.run({
                      policy: "local-write",
                      command: "update-ref",
                      args: ["--stdin"],
                      stdin: Buffer.from(
                        `start\nverify HEAD ${candidate}\nprepare\n`,
                      ),
                      verifyPrepared: async (assertActive) => {
                        await prove("index-prepared", verifyCommit);
                        active();
                        assertActive();
                        const indexedResult = append(
                          await client.run({
                            policy: "local-write",
                            command: "update-index",
                            args: ["-z", "--index-info"],
                            stdin: indexInfo,
                          }),
                        );
                        if (failed(indexedResult))
                          throw new ByteCommandError(
                            "verification",
                            indexedResult.processSettled,
                            indexedResult.stdout,
                            indexedResult.stderr,
                            indexedResult.exitCode,
                            indexedResult.signal,
                          );
                        indexPublished = true;
                        if (indexedResult.stderr.length) throw stale();
                        assertActive();
                      },
                    }),
                  );
                }, true);
              } catch (error) {
                if (error instanceof ByteCommandError)
                  log += text(error.stdout) + text(error.stderr);
                throw error;
              }
            },
            proveResult: async (command) => {
              if (
                command.signal !== null ||
                (command.exitCode === 0 && command.stderr.length)
              )
                throw stale();
              const proof = await prove(
                "result",
                command.exitCode === 0 ? verifyCommit : undefined,
              );
              if (command.exitCode === 0 && !indexPublished) throw stale();
              return {
                proof,
                verification: {
                  outcome: command.exitCode === 0 ? "completed" : "rejected",
                  afterHead: proof.head,
                  conflicts: [],
                  verifiedUnrelatedData: true,
                },
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
            ...(success && candidate ? { commit: candidate } : {}),
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
      return uncertain({
        ...observed,
        log: "Завершающая проверка коммита или освобождение контекста завершились ошибкой. Диагностика окружения скрыта.",
      });
    }
  }
}
