import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import {
  gitDiscardRecoveryRequestSchema,
  gitDiscardRequestSchema,
  gitDiscardTokenSchema,
  type GitDiscardRecovery,
  type GitDiscardRecoveryPreview,
  type GitDiscardRecoveryResult,
  type GitDiscardPreview,
} from "../shared/git-discard";
import type { ScopeRef } from "../shared/context";
import type { GitCommitContext } from "./git-workspace-actions";
import type { GitDiscardActions } from "./git-discard-actions";
import type { NativeGitState } from "./git-native-state";
import {
  assertNativeGitState,
  assertNoNativeGitLocks,
} from "./git-native-state";
import { nativeGitGuard, nativeIntent } from "./git-native-context";
import { safe } from "./git-conflict-state";
import { assertReadActive } from "./read-scope";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const stale = () =>
  Error(
    "Состояние восстановления изменилось. Проверьте его заново перед подтверждением.",
  );
type Context = ConstructorParameters<typeof GitDiscardActions>[0]["context"];
const git = (c: GitCommitContext, args: string[]) =>
  c.git([
    ...safe,
    `--git-dir=${path.join(c.root, ".git")}`,
    `--work-tree=${c.root}`,
    ...args,
  ]);
/** Same policy/capture for an actual discard and its read-only recovery assessment. */
export async function createDiscardGuard(
  c: GitCommitContext,
  names: string[],
  paths: string[],
) {
  const configuration = (await git(c, ["config", "--null", "--list"])).stdout
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const i = row.indexOf("\n");
      return [
        i < 0 ? row : row.slice(0, i),
        i < 0 ? "" : row.slice(i + 1),
      ] as const;
    });
  return nativeGitGuard({
    root: c.root,
    capability: c.native,
    paths,
    configuration,
    recoverIndex: true,
    verify: () => c.verify(),
    admittedStatus: async () => {
      const current = await c.snapshot();
      return {
        data: Buffer.from(JSON.stringify(current.files)),
        headRef: current.branch ? `refs/heads/${current.branch}` : null,
      };
    },
    policy: async () =>
      nativeIntent([
        (await git(c, ["config", "--null", "--list"])).stdout,
        (await git(c, ["ls-files", "-v", "-z"])).stdout
          .split("\0")
          .filter((row) => row && !names.includes(row.slice(2))),
      ]),
  });
}
type Guard = Awaited<ReturnType<typeof createDiscardGuard>>;
type RecordProof = NonNullable<
  Awaited<ReturnType<Guard["journal"]["readDiscardRecovery"]>>
>;
interface Assessment {
  value: GitDiscardRecovery;
  proof?: {
    record: RecordProof;
    current: NativeGitState;
    guard: Guard;
    intentDetails: string;
    names: string[];
  };
}
interface Ticket {
  scope: ScopeRef;
  expires: number;
  revision: string;
  fingerprint: string;
  current: NativeGitState;
  intentDetails: string;
  names: string[];
}
/** No filesystem mutation during inspection/preview. Only owner-token execution retires evidence. */
export class GitDiscardRecoveryActions {
  private retries = new Map<string, Ticket>();
  private acknowledgements = new Map<string, Ticket>();
  constructor(
    private context: Context,
    private now: () => number,
  ) {}
  private put(map: Map<string, Ticket>, token: string, ticket: Ticket) {
    for (const [key, item] of map)
      if (item.expires <= this.now()) map.delete(key);
    while (map.size >= 32) map.delete(map.keys().next().value!);
    map.set(token, ticket);
  }
  private async intent(c: GitCommitContext, record: RecordProof) {
    if (record.intentDetails) {
      const value: unknown = JSON.parse(record.intentDetails);
      if (
        !Array.isArray(value) ||
        value.length !== 3 ||
        value[0] !== "discard" ||
        !Array.isArray(value[1]) ||
        !Array.isArray(value[2])
      )
        throw stale();
      const names = gitDiscardRequestSchema.parse({
        scope: c.scope,
        revision: record.snapshot.revision,
        paths: value[1],
      }).paths;
      if (
        value[2].length !== names.length ||
        value[2].some(
          (item, i) =>
            !item ||
            item.path !== names[i] ||
            !["restore", "trash"].includes(item.action) ||
            Object.keys(item).sort().join() !== "action,path",
        )
      )
        throw stale();
      if (nativeIntent(value) !== record.intentFingerprint) throw stale();
      return { names, details: record.intentDetails };
    }
    // Legacy records have no explicit selection. Adopt only a reconstruction whose
    // exact original intent digest proves the paths/order/actions, never guess a subset.
    const names = record.snapshot.files.map((f) => f.path);
    gitDiscardRequestSchema.parse({
      scope: c.scope,
      revision: record.snapshot.revision,
      paths: names,
    });
    const rows = (
      await git(c, [
        "ls-tree",
        "-r",
        "-z",
        record.snapshot.head!,
        "--",
        ...names,
      ])
    ).stdout;
    const restored = new Set<string>();
    for (const row of rows.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob [a-f0-9]{40,64}\t([\s\S]+)$/.exec(
        row,
      );
      if (!match || !names.includes(match[2])) throw stale();
      restored.add(match[2]);
    }
    const value = [
      "discard",
      names,
      names.map((name) => ({
        path: name,
        action: restored.has(name) ? "restore" : "trash",
      })),
    ];
    if (nativeIntent(value) !== record.intentFingerprint) throw stale();
    return { names, details: JSON.stringify(value) };
  }
  private async classifiedPaths(
    c: GitCommitContext,
    record: RecordProof,
    current: NativeGitState,
    names: string[],
  ): Promise<GitDiscardRecovery["paths"]> {
    const rows = (
      await git(c, [
        "ls-tree",
        "-r",
        "-z",
        record.snapshot.head!,
        "--",
        ...names,
      ])
    ).stdout;
    const tree = new Map<string, { mode: string; oid: string }>();
    for (const row of rows.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(
        row,
      );
      if (!match || !names.includes(match[3])) throw stale();
      tree.set(match[3], { mode: match[1], oid: match[2] });
    }
    const index = Buffer.from(current.indexData, "base64")
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    const paths: GitDiscardRecovery["paths"] = [];
    for (const name of names) {
      const before = record.snapshot.files.find((f) => f.path === name);
      const after = current.files.find((f) => f.path === name);
      if (same(before, after)) {
        paths.push({ path: name, state: "unchanged" });
        continue;
      }
      const entry = tree.get(name),
        selected = index.filter(
          (row) => row.slice(row.indexOf("\t") + 1) === name,
        );
      let restored = !entry && after?.data === null && selected.length === 0;
      if (entry && after?.data !== null && after?.mode != null) {
        const blob = Buffer.from(
          (await git(c, ["cat-file", "blob", entry.oid])).stdout,
        );
        const hash = createHash("sha256").update(blob).digest("hex");
        restored =
          after.checksum === hash &&
          same(selected, [`${entry.mode} ${entry.oid} 0\t${name}`]) &&
          !!(after.mode & 0o111) === (entry.mode === "100755");
      }
      paths.push({ path: name, state: restored ? "restored" : "changed" });
    }
    return paths;
  }
  private async assess(
    c: GitCommitContext,
    preserve = false,
  ): Promise<Assessment> {
    const snapshot = await c.snapshot();
    const base = { scope: c.scope, revision: snapshot.revision, paths: [] };
    try {
      if (!c.native) throw stale();
      const record = await c.native.journal.readDiscardRecovery(
        c.root,
        await c.native.owner(),
      );
      if (!record)
        return {
          value: {
            ...base,
            state: "clear",
            message: "Незавершённой отмены изменений нет.",
          },
        };
      if (
        snapshot.operation !== "none" ||
        snapshot.files.some((f) => f.kind === "conflict")
      )
        return {
          value: {
            ...base,
            state: "blocked",
            message:
              "В Git выполняется другая операция. Завершите её перед восстановлением отмены; просмотр файлов доступен.",
          },
        };
      await assertNoNativeGitLocks(c.root);
      const intent = await this.intent(c, record);
      const protectedPaths = [
        ...new Set([
          ...record.snapshot.files.map((f) => f.path),
          ...(preserve
            ? snapshot.files.flatMap((f) => [
                f.path,
                ...(f.originalPath ? [f.originalPath] : []),
              ])
            : []),
        ]),
      ].sort();
      const guard = await createDiscardGuard(c, intent.names, protectedPaths);
      const current = await guard.capture();
      const unchanged = current.revision === record.snapshot.revision;
      const paths = unchanged
        ? intent.names.map((name) => ({
            path: name,
            state: "unchanged" as const,
          }))
        : await this.classifiedPaths(c, record, current, intent.names);
      await c.verify();
      if ((await c.snapshot()).revision !== snapshot.revision) throw stale();
      return {
        value: {
          ...base,
          paths,
          state: unchanged ? "unchanged" : "partial",
          message: unchanged
            ? "Текущее состояние совпадает со снимком до предыдущей отмены. Можно отменить изменения обычным способом; служебный снимок прежней отмены будет удалён после подтверждения."
            : "Состояние отличается от снимка предыдущей отмены. Можно сохранить текущее состояние файлов и завершить восстановление без повторной отмены.",
        },
        proof: {
          record,
          current,
          guard,
          intentDetails: intent.details,
          names: intent.names,
        },
      };
    } catch {
      assertReadActive();
      return {
        value: {
          ...base,
          state: "blocked",
          message:
            "Не удалось безопасно проверить незавершённую операцию. Файлы не изменены. Проверьте, что другие Git-операции завершены и рабочая папка доступна; просмотр проекта остаётся доступным.",
        },
      };
    }
  }
  inspect(scope: ScopeRef): Promise<GitDiscardRecovery> {
    return this.context(scope, async (c) => (await this.assess(c)).value);
  }
  async bindDiscard(preview: GitDiscardPreview): Promise<string | undefined> {
    return this.context(preview.scope, async (c) => {
      const a = await this.assess(c);
      if (a.value.state === "clear") return;
      if (a.value.state !== "unchanged" || !a.proof)
        throw Error(a.value.message);
      this.put(this.retries, preview.token, {
        scope: c.scope,
        expires: preview.expiresAt,
        revision: a.value.revision,
        fingerprint: a.proof.record.fingerprint,
        current: a.proof.current,
        intentDetails: a.proof.intentDetails,
        names: a.proof.names,
      });
      return a.value.message;
    });
  }
  async retireForDiscard(c: GitCommitContext, token: string) {
    const ticket = this.retries.get(token);
    this.retries.delete(token);
    if (!ticket) return; // Journal.execute still rejects any newly appeared blocker.
    if (
      ticket.expires <= this.now() ||
      !same(c.scope, ticket.scope) ||
      !c.native
    )
      throw stale();
    const guard = await createDiscardGuard(
      c,
      ticket.names,
      ticket.current.files.map((f) => f.path),
    );
    assertNativeGitState(ticket.current, await guard.capture());
    await guard.journal.retireDiscardRecovery({
      root: c.root,
      owner: await c.native.owner(),
      fingerprint: ticket.fingerprint,
      expectedCurrent: ticket.current,
      intentDetails: ticket.intentDetails,
      capture: guard.capture,
      mode: "retry-unchanged",
    });
  }
  async prepare(input: unknown): Promise<GitDiscardRecoveryPreview> {
    const request = gitDiscardRecoveryRequestSchema.parse(input);
    return this.context(request.scope, async (c) => {
      const a = await this.assess(c, true);
      if (
        request.revision !== a.value.revision ||
        !a.proof ||
        !["unchanged", "partial"].includes(a.value.state)
      )
        throw Error(a.value.message);
      const token = randomBytes(32).toString("hex"),
        expiresAt = this.now() + 300000;
      this.put(this.acknowledgements, token, {
        scope: c.scope,
        expires: expiresAt,
        revision: a.value.revision,
        fingerprint: a.proof.record.fingerprint,
        current: a.proof.current,
        intentDetails: a.proof.intentDetails,
        names: a.proof.names,
      });
      return {
        token,
        scope: c.scope,
        root: c.root,
        revision: a.value.revision,
        paths: a.value.paths,
        expiresAt,
        message:
          "Файлы, индекс, ветка и коммиты останутся в текущем состоянии. Предыдущая отмена не повторяется. Служебный снимок предыдущей отмены будет удалён без создания архива, после чего её блокировка будет снята.",
      };
    });
  }
  async execute(input: string): Promise<GitDiscardRecoveryResult> {
    const token = gitDiscardTokenSchema.parse(input),
      ticket = this.acknowledgements.get(token);
    this.acknowledgements.delete(token);
    if (!ticket || ticket.expires <= this.now()) throw stale();
    return this.context(ticket.scope, async (c) => {
      if (!c.native || (await c.snapshot()).revision !== ticket.revision)
        throw stale();
      const guard = await createDiscardGuard(
        c,
        ticket.names,
        ticket.current.files.map((f) => f.path),
      );
      assertNativeGitState(ticket.current, await guard.capture());
      await guard.journal.retireDiscardRecovery({
        root: c.root,
        owner: await c.native.owner(),
        fingerprint: ticket.fingerprint,
        expectedCurrent: ticket.current,
        intentDetails: ticket.intentDetails,
        capture: guard.capture,
        mode: "preserve-current",
      });
      return {
        scope: c.scope,
        status: "recovered",
        message:
          "Файлы оставлены в текущем состоянии. Служебный снимок предыдущей отмены удалён без создания архива; работу с Git можно продолжить.",
      };
    });
  }
}
