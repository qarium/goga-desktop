import { t as tr } from "../shared/i18n";
import type { GitUpdateAttemptInput } from "./git-native-update-handoff";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Project } from "../shared/types";
import type { TopicContextRef, WorktreeRecord } from "../shared/worktrees";
import { worktreeContextRef } from "../shared/worktrees";
import type { ContextSyncState } from "../shared/context-sync";
import type {
  RepositoryActionRequest,
  RepositoryActionResult,
} from "../shared/repository-actions";
import { assertLocalOrigin } from "./local-origin";
import { noSymlinks } from "./settings";
import { CommandExitError } from "./process";

interface Dependencies {
  project(): Promise<Project>;
  resolve(ref: TopicContextRef): Promise<WorktreeRecord>;
  inventory(): Promise<WorktreeRecord[]>;
  sync(
    project: Project,
    ref: TopicContextRef,
    onDiagnostic: (stdout: string, stderr: string) => void,
  ): Promise<ContextSyncState>;
  mergeTopic?(
    ref: TopicContextRef,
    source: string,
    verifySource: () => Promise<void>,
  ): Promise<{ outcome: string; log: string; lockRetained?: boolean }>;
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
  goga(args: string[]): Promise<{ stdout: string; stderr: string }>;
  gogaUpdate?(
    args: string[],
    input: GitUpdateAttemptInput,
  ): Promise<{ stdout: string; stderr: string }>;
  gogaOriginal(args: string[]): Promise<{ stdout: string; stderr: string }>;
  withOriginalTopicBranch(
    branch: string,
    expectedOid: string,
    action: () => Promise<void>,
    diagnostic: (message: string) => void,
  ): Promise<void>;
  verify(): Promise<void>;
  secrets: string[];
}
const changed = () =>
  Error(
    tr("host.ownerBranchOrGitSettingsChangedVerifyThemAndRetry"),
  );
const oid = (value: string) =>
  z
    .string()
    .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
    .parse(value.trim());
/** Bounded operation output, with environment values and URL credentials removed. */
export function sanitizeRepositoryLog(
  value: string,
  secrets: string[] = [],
): string {
  let text = stripVTControlCharacters(value).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    "",
  );
  for (const secret of [...secrets]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    for (const variant of new Set([secret, encodeURIComponent(secret)]))
      text = text.split(variant).join(tr("host.hidden"));
  }
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, tr("host.1Hidden"))
    .replace(
      /([?&](?:token|password|secret|key|access_token)=)[^\s&#]+/gi,
      tr("host.1Hidden2"),
    )
    .slice(-65536);
}
export function repositoryActionFailure(
  request: RepositoryActionRequest,
  error: unknown,
  log = "",
  secrets: string[] = [],
): RepositoryActionResult {
  const message = sanitizeRepositoryLog(
    error instanceof Error ? error.message : tr("host.operationFailed"),
    secrets,
  );
  return {
    projectId: request.projectId,
    ...(request.context ? { contextId: request.context.contextId } : {}),
    action: request.action,
    status: "error",
    log: sanitizeRepositoryLog(tr("host.logNerrorMessage", { log: log, message: message }), secrets),
    error: message.split("\n")[0].slice(0, 500),
  };
}

/** Host-only orchestration; the service supplies serialized, settings-bound capabilities. */
export class RepositoryActions {
  private lines: string[] = [];
  private owner?: WorktreeRecord;
  private project!: Project;
  private common = "";
  private propagation?: RepositoryActionRequest["propagation"];
  constructor(private deps: Dependencies) {}
  private async git(args: string[], cwd = this.project.path, output = false) {
    await this.deps.verify();
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    const result = await this.deps.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        ...args,
      ],
      cwd,
    );
    if (output) this.lines.push(result.stdout, result.stderr);
    return result.stdout;
  }
  private async verify(nativeOwnerAdmitted = false) {
    await this.deps.verify();
    const project = await this.deps.project();
    if (
      project.id !== this.project.id ||
      project.path !== this.project.path ||
      (await realpath(project.path)) !== project.path
    )
      throw changed();
    if (
      (
        await this.git([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim() !== this.common
    )
      throw changed();
    if (this.propagation) {
      const target = this.propagation;
      const owners = (await this.deps.inventory()).filter(
        (record) =>
          record.projectId === this.project.id &&
          record.year === target.year &&
          record.topic === target.topic &&
          record.branch === target.branch &&
          !record.deletedAt,
      );
      if (
        this.owner
          ? owners.length !== 1 ||
            JSON.stringify(owners[0]) !== JSON.stringify(this.owner)
          : owners.length !== 0
      )
        throw Error(
          tr("host.topicOwnershipChangedOrIsAmbiguousRefreshTheCardAnd"),
        );
    }
    if (this.owner && !nativeOwnerAdmitted) {
      const current = await this.deps.resolve(worktreeContextRef(this.owner));
      if (JSON.stringify(current) !== JSON.stringify(this.owner))
        throw changed();
    }
  }
  private async currentBranch(cwd = this.project.path) {
    const ref = (
      await this.git(["symbolic-ref", "--quiet", "HEAD"], cwd)
    ).trim();
    if (!ref.startsWith("refs/heads/"))
      throw Error(
        tr("host.noLocalBranchIsCheckedOutInTheOriginalFolder"),
      );
    return ref.slice(11);
  }
  private async directBranch(value: string, cwd = this.project.path) {
    const branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
    if (
      !branch ||
      branch.startsWith("-") ||
      branch.startsWith("refs/") ||
      /[\x00-\x20\x7f]/.test(branch)
    )
      throw Error(
        tr("host.theBaseMustBeAnUnambiguousLocalBranchNotA"),
      );
    const ref = `refs/heads/${branch}`;
    await this.git(["check-ref-format", ref], cwd);
    const rows = (
      await this.git(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
          ref,
          `refs/tags/${branch}`,
        ],
        cwd,
      )
    )
      .trim()
      .split("\n")
      .map((row) => row.split("\0"));
    const match = rows.find((row) => row[0] === ref);
    if (
      !match ||
      match[2] ||
      rows.some((row) => row[0] === `refs/tags/${branch}`)
    )
      throw Error(
        tr("host.theBaseBranchIsMissingSymbolicOrAmbiguousWithA"),
      );
    return { branch, ref, oid: oid(match[1]) };
  }
  private async remote(name: string, push: boolean, cwd = this.project.path) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name === ".")
      throw Error(tr("host.theUpstreamRemoteIsMissingOrAmbiguous"));
    const prefix = `remote.${name}.`;
    const raw = await this.git(
      ["config", "--local", "--includes", "--null", "--list"],
      cwd,
    );
    const rows = raw
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const n = row.indexOf("\n");
        return [row.slice(0, n), row.slice(n + 1)];
      })
      .filter(([key]) => key.startsWith(prefix));
    if (
      !rows.length ||
      rows.some(
        ([key]) =>
          !["url", "pushurl", "fetch"].includes(key.slice(prefix.length)),
      )
    )
      throw Error(
        tr("host.remoteNameIsMissingOrHasUnsafeSettings", { name: name }),
      );
    for (const key of ["url", "pushurl", "fetch"]) {
      const values = rows.filter(([k]) => k === prefix + key);
      if (values.length > 1 || (key === "url" && values.length !== 1))
        throw Error(tr("host.remoteNameIsAmbiguous", { name: name }));
    }
    const endpoint = (
      await this.git(
        ["remote", "get-url", ...(push ? ["--push"] : []), "--all", name],
        cwd,
      )
    ).trim();
    if (
      !endpoint ||
      endpoint.startsWith("-") ||
      /[\x00-\x20\x7f]/.test(endpoint) ||
      endpoint.includes("::")
    )
      throw Error(tr("host.remoteNameHasAnInvalidAddress", { name: name }));
    return JSON.stringify([rows, endpoint]);
  }
  private async publish(branch: string, expected?: string) {
    this.lines.push(
      tr("host.publishingBranchBranchFromTheOriginalProjectToOrigin", { branch: branch }),
    );
    const source = await this.directBranch(branch);
    if (expected && source.oid !== expected) throw changed();
    const endpoint = await this.remote("origin", true);
    await this.verify();
    if (
      (await this.remote("origin", true)) !== endpoint ||
      (await this.directBranch(branch)).oid !== source.oid
    )
      throw changed();
    await this.git(
      [
        "-c",
        "push.gpgSign=false",
        "-c",
        "push.negotiate=false",
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--recurse-submodules=no",
        "origin",
        `${source.oid}:${source.ref}`,
      ],
      this.project.path,
      true,
    );
    await this.verify();
    if ((await this.remote("origin", true)) !== endpoint) throw changed();
    this.lines.push(tr("host.publicationComplete"));
  }
  private async refreshBase(
    value: string,
    source?: {
      remote: string;
      ref: string;
      cwd?: string;
      expected?: string;
      guard?: () => Promise<void>;
    },
    allowLocalBase = false,
  ) {
    const branchLabel = source ? tr("host.topicBranch") : tr("host.baseBranch");
    const cwd = source?.cwd ?? this.project.path;
    const git = (args: string[], _cwd = cwd, output = false) =>
      this.git(args, _cwd, output);
    const base = await this.directBranch(value, cwd);
    const common = (
      await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    const verifyOwner = async () => {
      await this.verify();
      await source?.guard?.();
      if (source && this.owner) {
        if (
          (await this.currentBranch(this.owner.path)) !== this.owner.branch ||
          !(await assertLocalOrigin(this.owner, (args, root) =>
            this.git(args, root),
          ))
        )
          throw changed();
      }
    };
    const assertIdle = async () => {
      const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
      for (const file of [
        "index.lock",
        "HEAD.lock",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
      ]) {
        const full = path.join(gitDir, file);
        await noSymlinks(full);
        try {
          await lstat(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw Error(
          tr("host.aGitOperationIsAlreadyInProgressInTheOriginal2"),
        );
      }
      for (const file of ["packed-refs.lock", `${base.ref}.lock`]) {
        const full = path.join(common, file);
        await noSymlinks(full);
        try {
          await lstat(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw Error(tr("host.theBaseBranchIsBusyWithAGitOperation"));
      }
    };
    await assertIdle();
    this.lines.push(
      tr("host.updatingBranchlabelBranchFromValue3FastForwardOnly", { branchLabel: branchLabel, branch: base.branch, value3: source?.remote ?? "upstream" }),
    );
    const upstream = async () =>
      (
        await git([
          "for-each-ref",
          "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
          base.ref,
        ])
      )
        .trim()
        .split("\n")
        .map((row) => row.split("\0"))
        .find((row) => row[0] === base.ref);
    const tracking = source
      ? [base.ref, source.remote, source.ref]
      : await upstream();
    const localBase = async () => {
      await verifyOwner();
      await assertIdle();
      if ((await this.directBranch(base.branch, cwd)).oid !== base.oid)
        throw changed();
      this.lines.push(
        tr("host.usingLocalBaseBranchTheBranchDoesNotHaveTo", { branch: base.branch }),
      );
      return base;
    };
    if (!tracking?.[1] || !tracking[2]) {
      if (allowLocalBase) return localBase();
      throw Error(tr("host.branchBranchHasNoUnambiguousUpstream", { branch: base.branch }));
    }
    if (!tracking[2].startsWith("refs/heads/"))
      throw Error(tr("host.branchBranchHasNoUnambiguousUpstream", { branch: base.branch }));
    await git(["check-ref-format", tracking[2]]);
    if (
      allowLocalBase &&
      !(await git(["remote"])).trim().split("\n").includes(tracking[1])
    )
      return localBase();
    const endpoint = await this.remote(tracking[1], false, cwd);
    const verify = async () => {
      await verifyOwner();
      await assertIdle();
      if (
        (!source &&
          JSON.stringify(await upstream()) !== JSON.stringify(tracking)) ||
        (await this.remote(tracking[1], false, cwd)) !== endpoint ||
        (await this.directBranch(base.branch, cwd)).oid !== base.oid
      )
        throw changed();
    };
    await verify();
    if (allowLocalBase) {
      try {
        const rows = (
          await git([
            "ls-remote",
            "--exit-code",
            "--refs",
            tracking[1],
            tracking[2],
          ])
        )
          .trim()
          .split("\n")
          .map((row) => row.split("\t"));
        const match = rows.find(([, ref]) => ref === tracking[2]);
        if (!match) throw changed();
        oid(match[0]);
      } catch (error) {
        // Git documents exit 2 specifically for an absent matching ref.
        // Authentication, transport, cancellation and malformed output remain failures.
        if (!(error instanceof CommandExitError) || error.exitCode !== 2)
          throw error;
        await verify();
        return localBase();
      }
      await verify();
    }
    const fetched = `refs/desktop/repository-actions/${randomUUID()}`;
    await git(
      [
        ...(cwd !== this.project.path
          ? ["-c", "protocol.allow=never", "-c", "protocol.file.allow=always"]
          : []),
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        tracking[1],
        `${tracking[2]}:${fetched}`,
      ],
      cwd,
      true,
    );
    let next = oid(await git(["rev-parse", "--verify", `${fetched}^{commit}`]));
    if (source?.expected && next !== source.expected) throw changed();
    try {
      await git(["merge-base", "--is-ancestor", base.oid, next]);
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
      // A local branch ahead of upstream is already up to date; never reset it backwards.
      try {
        await git(["merge-base", "--is-ancestor", next, base.oid]);
      } catch (reverseError) {
        if (
          !(reverseError instanceof CommandExitError) ||
          reverseError.exitCode !== 1
        )
          throw reverseError;
        throw Error(
          tr("host.theHistoriesOfBranchlabelBranchAndValue3HaveDivergedMerge", { branchLabel: branchLabel, branch: base.branch, value3: source?.remote ?? "upstream" }),
        );
      }
      next = base.oid;
    }
    await verify();
    const assertNotElsewhere = async () => {
      const worktrees = (
        await git(["worktree", "list", "--porcelain", "-z"])
      ).split("\0\0");
      const elsewhere = worktrees.some(
        (block) =>
          block.split("\0").includes(`branch ${base.ref}`) &&
          !block.split("\0").includes(`worktree ${cwd}`),
      );
      if (elsewhere)
        throw Error(
          tr("host.theBaseBranchIsCheckedOutInAnotherWorkingCopy"),
        );
    };
    await assertNotElsewhere();
    const head = (
      await git(["rev-parse", "--symbolic-full-name", "HEAD"])
    ).trim();
    await verify();
    if (head === base.ref) {
      if ((await this.currentBranch(cwd)) !== base.branch) throw changed();
      await git(
        [
          "-c",
          "merge.autoStash=false",
          "-c",
          "rebase.autoStash=false",
          "-c",
          `branch.${base.branch}.mergeOptions=`,
          "merge",
          "--ff-only",
          "--no-autostash",
          "--no-edit",
          next,
        ],
        cwd,
        true,
      );
    } else {
      // Verification yields to other Git clients. Never CAS a branch that became
      // checked out meanwhile: moving only its ref would leave stale files/index.
      await assertNotElsewhere();
      if (
        (await git(["rev-parse", "--symbolic-full-name", "HEAD"])).trim() !==
        head
      )
        throw changed();
      await git(
        ["update-ref", "--no-deref", base.ref, next, base.oid],
        cwd,
        true,
      );
    }
    await verifyOwner();
    if ((await this.remote(tracking[1], false, cwd)) !== endpoint)
      throw changed();
    if ((await this.directBranch(base.branch, cwd)).oid !== next)
      throw changed();
    this.lines.push(
      source
        ? tr("host.topicBranchBranchUpdated", { branch: base.branch })
        : tr("host.baseBranchBranchUpdated", { branch: base.branch }),
    );
    return { ...base, oid: next };
  }
  /** Manual sync receives only the same named local branch, never base_ref or server origin. */
  private async receiveTopicBranch() {
    const owner = this.owner!;
    const sourceRef = `refs/heads/${owner.branch}`;
    await this.git(["check-ref-format", sourceRef]);
    const sourceRows = (
      await this.git(["for-each-ref", "--format=%(refname)", sourceRef])
    )
      .trim()
      .split("\n");
    if (!sourceRows.includes(sourceRef)) {
      this.lines.push(
        tr("host.thereIsNoMatchingBranchInTheOriginalProjectYet"),
      );
      return;
    }
    const source = await this.directBranch(owner.branch);
    const head = oid(
      await this.git(["rev-parse", "--verify", "HEAD^{commit}"], owner.path),
    );
    const verifySource = async (nativeOwnerAdmitted = false) => {
      // Native context already holds and verifies the clone lifecycle lock.
      // Do not re-enter the ordinary resolving/repairing clone path under it.
      await this.verify(nativeOwnerAdmitted);
      if (
        (await this.directBranch(owner.branch)).oid !== source.oid ||
        (await this.currentBranch(owner.path)) !== owner.branch ||
        !(await assertLocalOrigin(owner, (args, cwd) => this.git(args, cwd)))
      )
        throw changed();
    };
    await verifySource();
    this.lines.push(tr("host.fetchingTheMatchingBranchFromTheOriginalProjectIntoThe"));
    // Object-only fetch: no FETCH_HEAD or persistent scratch/tracking references.
    // The original direct ref is pinned/rechecked; native Git seals the exact OID.
    await this.git(
      [
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--refmap=",
        "origin",
        source.ref,
      ],
      owner.path,
      true,
    );
    await verifySource();
    if (
      (await this.git(["cat-file", "-t", source.oid], owner.path)).trim() !==
        "commit" ||
      oid(
        await this.git(["rev-parse", "--verify", "HEAD^{commit}"], owner.path),
      ) !== head
    )
      throw changed();
    try {
      await this.git(
        ["merge-base", "--is-ancestor", source.oid, head],
        owner.path,
      );
      this.lines.push(
        tr("host.theCopyAlreadyContainsTheSourceBranchCommitsItsFiles"),
      );
      return;
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
    }
    if (!this.deps.mergeTopic)
      throw Error(
        tr("host.cannotSafelyFetchCommitsNothingWasExported"),
      );
    const merged = await this.deps.mergeTopic(
      worktreeContextRef(owner),
      source.oid,
      () => verifySource(true),
    );
    this.lines.push(merged.log);
    if (merged.outcome === "conflicts")
      throw Error(
        tr("host.theCopyHasConflictsResolveThemInChangesFinishThe"),
      );
    if (merged.outcome !== "completed" || merged.lockRetained)
      throw Error(
        tr("host.theResultOfFetchingCommitsNeedsVerificationTheReturnTransfer"),
      );
    await verifySource();
    this.lines.push(tr("host.theCopyIncludesTheSourceBranchCommits"));
  }
  private async updateCloneTracking(branch: string, next: string) {
    const ref = `refs/remotes/origin/${branch}`;
    const rows = (
      await this.git(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
          ref,
        ],
        this.owner!.path,
      )
    )
      .trim()
      .split("\n")
      .map((row) => row.split("\0"));
    const existing = rows.find((row) => row[0] === ref);
    if (existing?.[2])
      throw Error(
        tr("host.theCloneSOriginBaseRefIsSymbolicUpdatingIs"),
      );
    const previous = existing ? oid(existing[1]) : "0".repeat(next.length);
    if (existing)
      await this.git(
        ["merge-base", "--is-ancestor", previous, next],
        this.owner!.path,
      );
    await this.verify();
    await this.git(
      ["update-ref", "--no-deref", ref, next, previous],
      this.owner!.path,
      true,
    );
    this.lines.push(tr("host.theCloneSBaseOriginBranchWasUpdated", { branch: branch }));
  }
  private async propagateOriginal(
    branch: string,
    expectedOid: string,
    args: string[],
    verify: () => Promise<void>,
    message: string,
  ) {
    await this.deps.withOriginalTopicBranch(
      branch,
      expectedOid,
      async () => {
        await verify();
        this.lines.push(message);
        try {
          const result = await this.deps.gogaOriginal(args);
          this.lines.push(
            result.stdout,
            result.stderr,
            tr("host.gogaTopicsPropagateCompleted"),
          );
        } catch (error) {
          // Keep CLI diagnostics even if returning to the original branch fails.
          if (error instanceof CommandExitError) {
            this.lines.push(error.stdout, error.stderr);
            throw Error(error.message, { cause: error });
          }
          throw error;
        }
      },
      (message) => this.lines.push(message),
    );
  }
  /** Explicit card publication never borrows the selected header owner or configured base. */
  private async propagateSelected(request: RepositoryActionRequest) {
    const target = request.propagation!;
    const normalized = target.branch
      .toLowerCase()
      .replace(/[^\x00-\x7f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (
      target.topic !== normalized ||
      target.branch.startsWith("refs/") ||
      target.baseRef.startsWith("refs/")
    )
      throw Error(
        tr("host.onlyTheSelectedTopicSOwnLocalBranchCanBe"),
      );
    if (target.branch === target.baseRef)
      throw Error(tr("host.theDestinationBranchMustDifferFromTheTopicBranch"));
    const source = await this.directBranch(
      target.branch,
      this.owner?.path ?? this.project.path,
    );
    const base = await this.directBranch(target.baseRef);
    const endpoint = await this.remote("origin", true);
    const guard = async (imported?: string) => {
      await this.verify();
      if (
        (await this.directBranch(base.branch)).oid !== base.oid ||
        (await this.remote("origin", true)) !== endpoint ||
        (
          await this.directBranch(
            source.branch,
            this.owner?.path ?? this.project.path,
          )
        ).oid !== source.oid
      )
        throw changed();
      if (
        this.owner &&
        ((await this.currentBranch(this.owner.path)) !== source.branch ||
          !(await assertLocalOrigin(this.owner, (args, cwd) =>
            this.git(args, cwd),
          )))
      )
        throw changed();
      if (
        imported &&
        (imported !== source.oid ||
          (await this.directBranch(source.branch)).oid !== imported)
      )
        throw changed();
      await this.verify();
    };
    await guard();
    let imported: string | undefined;
    if (this.owner) {
      this.lines.push(tr("host.syncingTopicToLocalOrigin"));
      const result = await this.deps.sync(
        this.project,
        request.context!,
        (stdout, stderr) => {
          this.lines.push(stdout, stderr);
        },
      );
      if (result.status !== "synced" || !result.importedOid)
        throw Error(
          result.error ??
            tr("host.syncDidNotFinishNothingWasPublished"),
        );
      imported = result.importedOid;
      this.lines.push(tr("host.topicSyncComplete"));
    }
    await guard(imported);
    await this.propagateOriginal(
      source.branch,
      imported ?? source.oid,
      [
        "topics",
        "--year",
        target.year,
        "propagate",
        source.branch,
        "--base-ref",
        base.branch,
        "-y",
      ],
      () => guard(imported),
      tr("host.publishingTopicBranchToBranchValue2GogaTopicsPropagateOriginal", { branch: target.branch, value2: base.branch }),
    );
    this.lines.push(tr("host.topicPublicationComplete"));
  }
  async run(request: RepositoryActionRequest): Promise<RepositoryActionResult> {
    try {
      this.propagation = request.propagation;
      this.project = await this.deps.project();
      await noSymlinks(this.project.path);
      this.common = (
        await this.git([
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).trim();
      if (request.context)
        this.owner = await this.deps.resolve(request.context);
      await this.verify();
      if (request.action === "propagate" && !this.owner && !request.propagation)
        throw Error(
          tr("host.propagatingToBaseRequiresASelectedTopicContext"),
        );
      if (
        this.owner &&
        !(await assertLocalOrigin(this.owner, (args, cwd) =>
          this.git(args, cwd),
        ))
      )
        throw Error(
          tr("host.theCloneHasNoLocalOriginSettingsWereNotChanged"),
        );
      if (request.action === "propagate" && request.propagation) {
        await this.propagateSelected(request);
      } else if (request.action === "update-remote") {
        if (!this.owner)
          throw Error(tr("host.updatingFromRemoteRequiresATopic"));
        const branch = this.owner.branch;
        if ((await this.currentBranch(this.owner.path)) !== branch)
          throw changed();
        this.lines.push(
          tr("host.fetchingBranchBranchFromTheOriginalProjectSOrigin", { branch: branch }),
        );
        const hasOrigin = (await this.git(["remote"]))
          .trim()
          .split("\n")
          .includes("origin");
        const endpoint = hasOrigin
          ? await this.remote("origin", false)
          : undefined;
        const assertOriginalOrigin = async () => {
          if (
            (await this.git(["remote"]))
              .trim()
              .split("\n")
              .includes("origin") !== hasOrigin ||
            (hasOrigin && (await this.remote("origin", false)) !== endpoint)
          )
            throw changed();
        };
        const original = await this.refreshBase(
          branch,
          {
            remote: "origin",
            ref: `refs/heads/${branch}`,
            guard: assertOriginalOrigin,
          },
          true,
        );
        await this.verify();
        if (
          !(await assertLocalOrigin(this.owner, (args, cwd) =>
            this.git(args, cwd),
          ))
        )
          throw changed();
        this.lines.push(
          tr("host.fetchingTheUpdatedBranchIntoTheCloneThroughItsLocal"),
        );
        await this.refreshBase(branch, {
          remote: "origin",
          ref: original.ref,
          cwd: this.owner.path,
          expected: original.oid,
          guard: async () => {
            await assertOriginalOrigin();
            if ((await this.directBranch(branch)).oid !== original.oid)
              throw changed();
          },
        });
        this.lines.push(tr("host.topicUpdatedFromTheOriginalProjectWithoutPublishing"));
      } else if (request.action === "update-base") {
        if (!this.owner)
          throw Error(tr("host.updatingFromTheBaseBranchRequiresATopic"));
        this.lines.push(
          tr("host.readingEffectiveConfigurationGogaConfigTopicsClone"),
        );
        const output = await this.deps.goga(["config", "topics"]);
        const document = parseDocument(output.stdout, { uniqueKeys: true });
        if (document.errors.length)
          throw Error(tr("host.invalidEffectiveTopicsConfiguration"));
        const parsed = z
          .object({
            base_ref: z.string().min(1),
            update: z.object({ strategy: z.string().optional() }).optional(),
          })
          .safeParse(document.toJS({ maxAliasCount: 10 }));
        if (!parsed.success)
          throw Error(
            tr("host.theEffectiveTopicsConfigurationIsMissingBaseRefOrHas"),
          );
        const base = await this.refreshBase(
          parsed.data.base_ref,
          undefined,
          true,
        );
        await this.verify();
        if (
          !(await assertLocalOrigin(this.owner, (args, cwd) =>
            this.git(args, cwd),
          ))
        )
          throw Error(tr("host.theCloneHasNoLocalOrigin"));
        const cloneRef = `refs/desktop/repository-actions/${randomUUID()}`;
        this.lines.push(tr("host.fetchingTheUpdatedBaseIntoTheClone"));
        await this.git(
          [
            "-c",
            "protocol.allow=never",
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "origin",
            `${base.ref}:${cloneRef}`,
          ],
          this.owner.path,
          true,
        );
        if (
          oid(
            await this.git(
              ["rev-parse", "--verify", `${cloneRef}^{commit}`],
              this.owner.path,
            ),
          ) !== base.oid
        )
          throw changed();
        await this.updateCloneTracking(base.branch, base.oid);
        await this.verify();
        if (
          !(await assertLocalOrigin(this.owner, (args, cwd) =>
            this.git(args, cwd),
          ))
        )
          throw changed();
        this.lines.push(
          tr("host.updatingTopicGogaTopicsUpdateCloneWithoutPublishing"),
        );
        // Native Goga reads topics.update.strategy itself; there is no --strategy option.
        const updateArgs = [
          "topics",
          "--year",
          this.owner.year,
          "update",
          this.owner.branch,
          "--base-ref",
          cloneRef,
        ];
        const result = this.deps.gogaUpdate
          ? await this.deps.gogaUpdate(updateArgs, {
              targetBranch: this.owner.branch,
              sourceRef: cloneRef,
              baseRef: parsed.data.base_ref,
            })
          : await this.deps.goga(updateArgs);
        this.lines.push(
          result.stdout,
          result.stderr,
          tr("host.topicUpdateComplete"),
        );
      } else if (this.owner) {
        if (request.action === "sync") await this.receiveTopicBranch();
        this.lines.push(tr("host.syncingTopicToLocalOrigin"));
        const result = await this.deps.sync(
          this.project,
          request.context!,
          (stdout, stderr) => {
            this.lines.push(stdout, stderr);
          },
        );
        if (result.status !== "synced" || !result.importedOid)
          throw Error(
            result.error ??
              tr("host.syncDidNotFinishLaterStepsWereNotExecuted"),
          );
        this.lines.push(tr("host.topicSyncComplete"));
        await this.verify();
        if (request.action === "publish")
          await this.publish(this.owner.branch, result.importedOid);
        else if (request.action === "propagate") {
          if (
            (await this.directBranch(this.owner.branch)).oid !==
            result.importedOid
          )
            throw changed();
          await this.verify();
          // Native Goga owns base selection, merge strategy and base publication.
          await this.propagateOriginal(
            this.owner.branch,
            result.importedOid,
            [
              "topics",
              "--year",
              this.owner.year,
              "propagate",
              this.owner.branch,
              "-y",
            ],
            async () => {
              await this.verify();
              if (
                (await this.directBranch(this.owner!.branch)).oid !==
                result.importedOid
              )
                throw changed();
            },
            tr("host.propagatingTopicToBaseGogaTopicsPropagateOriginalProjectPublishing"),
          );
          this.lines.push(tr("host.propagationToBaseComplete"));
        }
      } else if (request.action === "publish")
        await this.publish(await this.currentBranch());
      else await this.refreshBase(await this.currentBranch());
      await this.verify();
      return {
        projectId: request.projectId,
        ...(request.context ? { contextId: request.context.contextId } : {}),
        action: request.action,
        status: "success",
        log: sanitizeRepositoryLog(this.lines.join("\n"), this.deps.secrets),
      };
    } catch (error) {
      if (error instanceof CommandExitError)
        this.lines.push(error.stdout, error.stderr);
      return repositoryActionFailure(
        request,
        error,
        this.lines.join("\n"),
        this.deps.secrets,
      );
    }
  }
}
