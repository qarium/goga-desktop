import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CloneStore } from "./clone-store";
import { assertLocalOrigin } from "./local-origin";
import { noSymlinks } from "./settings";
import { childEnvironment } from "./process-environment";
import { RunnerShutdownError, type Runner } from "./process";
import {
  topicContextRefSchema,
  worktreeContextRef,
  worktreeRecordSchema,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";

export interface BaseSnapshot {
  id: string;
  owner: TopicContextRef;
  /** The user's selected primary ref, never the current selector at execution. */
  baseRef: string;
  sourceOid: string;
  /** Fresh, write-once clone ref. Update receives this pinned ref. */
  cloneRef: string;
  cloneHead: string;
}
export interface ContextExchangeDependencies {
  resolve(ref: TopicContextRef): Promise<WorktreeRecord>;
  isActive(contextId: string): boolean;
  isProjectActive?(projectId: string): boolean;
  nativeEnvironment?(
    ref: TopicContextRef,
  ): NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
}
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const changed = () =>
  new Error(
    "Контекст, база или подтверждение изменены/устарели. Обновите данные и создайте новый предпросмотр.",
  );
const oid = (value: string) => {
  const result = value.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw changed();
  return result;
};
function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  return env;
}
async function git(
  runner: Pick<Runner, "command">,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  await noSymlinks(cwd);
  await noSymlinks(path.join(cwd, ".git"));
  const result = await runner.command(
    "git",
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
    { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  );
  await noSymlinks(cwd);
  await noSymlinks(path.join(cwd, ".git"));
  return result.stdout;
}
export interface PublicationSnapshot {
  id: string;
  owner: TopicContextRef;
  action: "publish" | "update" | "propagate";
  policyHash: string;
  cloneHead: string;
  details: string[];
  /** Genuine branch spelling for native propagate, never a service ref. */
  baseRef?: string;
  base?: BaseSnapshot;
}
const policyError = () =>
  new Error(
    "Origin/upstream отсутствует, неоднозначен или изменён. Проверьте origin основной папки и политику клона; публикация не выполнялась.",
  );
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const policySchema = z
  .object({
    schemaVersion: z.literal(1),
    contextId: z.string(),
    ownerHash: digestSchema,
    primaryHash: digestSchema,
    cloneHash: digestSchema,
    endpointsHash: digestSchema,
  })
  .strict();
type UpstreamPolicy = z.infer<typeof policySchema>;
type OriginConfig = { url: string; pushurl?: string; fetch?: string };
const policyFile = (owner: WorktreeRecord) =>
  path.join(owner.gitCommonDir, "desktop-upstream-policy.json");
async function readPolicy(
  owner: WorktreeRecord,
): Promise<UpstreamPolicy | undefined> {
  const file = policyFile(owner);
  await noSymlinks(file);
  let fd;
  try {
    fd = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw policyError();
  }
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw policyError();
    return policySchema.parse(JSON.parse(await fd.readFile("utf8")));
  } catch {
    throw policyError();
  } finally {
    await fd.close();
  }
}
async function ownerHash(owner: WorktreeRecord) {
  const file = path.join(owner.gitCommonDir, "desktop-owner.json");
  await noSymlinks(file);
  return hash(
    JSON.stringify([
      owner.contextId,
      owner.path,
      owner.projectPath,
      owner.gitCommonDir,
      owner.sourceCommonDir,
      await readFile(file, "utf8"),
    ]),
  );
}
async function originConfig(
  runner: Pick<Runner, "command">,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<OriginConfig | undefined> {
  const raw = await git(
    runner,
    ["config", "--local", "--includes", "--null", "--list"],
    cwd,
    env,
  );
  const rows = raw
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const split = row.indexOf("\n");
      return [row.slice(0, split), row.slice(split + 1)];
    })
    .filter(([key]) => key.startsWith("remote.origin."));
  if (!rows.length) return;
  if (
    rows.some(
      ([key]) =>
        ![
          "remote.origin.url",
          "remote.origin.pushurl",
          "remote.origin.fetch",
        ].includes(key),
    )
  )
    throw policyError();
  const result: Partial<OriginConfig> = {};
  for (const name of ["url", "pushurl", "fetch"] as const) {
    const values = rows
      .filter(([key]) => key === `remote.origin.${name}`)
      .map(([, value]) => value);
    if (
      values.length > 1 ||
      values.some((value) => !value || /[\x00-\x1f\x7f]/.test(value))
    )
      throw policyError();
    if (values.length) result[name] = values[0];
  }
  if (!result.url) throw policyError();
  return result as OriginConfig;
}
async function canonicalEndpoint(
  value: string,
  owner: WorktreeRecord,
  runner: Pick<Runner, "command">,
  env: NodeJS.ProcessEnv,
) {
  if (!value || value.startsWith("-") || /[\x00-\x1f\x7f]/.test(value))
    throw policyError();
  let local: string | undefined;
  if (path.isAbsolute(value)) local = value;
  else if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.hostname && url.hostname !== "localhost")
      )
        throw policyError();
      local = fileURLToPath(url);
    } catch {
      throw policyError();
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (
        !["http:", "https:", "ssh:", "git:"].includes(url.protocol) ||
        !url.hostname ||
        url.hash
      )
        throw policyError();
      return url.toString();
    } catch {
      throw policyError();
    }
  } else if (
    /^(?:[^\s/@:]+@)?[^\s/:]+:[^\s]+$/.test(value) &&
    !value.includes("::") &&
    !value.includes("://")
  )
    return value;
  else throw policyError();
  let canonical: string;
  try {
    canonical = await realpath(local!);
  } catch {
    throw policyError();
  }
  if (
    canonical === "/dev/null" ||
    [owner.projectPath, owner.sourceCommonDir!].some(
      (base) => canonical === base || canonical.startsWith(base + path.sep),
    )
  )
    throw policyError();
  // A different linked checkout can still share the primary's common directory.
  try {
    const common = (
      await git(
        runner,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        canonical,
        env,
      )
    ).trim();
    if ((await realpath(common)) === owner.sourceCommonDir) throw policyError();
  } catch {
    throw policyError();
  }
  return `file:${canonical}`;
}
function maskedEndpoint(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value.replace(/^[^@/:]+@/, "").split(/[?#]/)[0];
  }
}
async function endpoints(
  runner: Pick<Runner, "command">,
  cwd: string,
  owner: WorktreeRecord,
  env: NodeJS.ProcessEnv,
  config?: OriginConfig,
) {
  const result = [];
  const rules = config
    ? (await git(runner, ["config", "--null", "--list"], cwd, env))
        .split("\0")
        .filter(Boolean)
        .map((row) => {
          const n = row.indexOf("\n");
          return [row.slice(0, n), row.slice(n + 1)];
        })
    : [];
  for (const push of [false, true]) {
    let value: string;
    if (config) {
      // Git's URL rewrite is longest-prefix; explicit pushurl disables pushInsteadOf.
      const original = push ? config.pushurl || config.url : config.url;
      const rewrite = (suffix: string) =>
        rules
          .filter(
            ([key, prefix]) =>
              key.startsWith("url.") &&
              key.endsWith(suffix) &&
              original.startsWith(prefix),
          )
          .sort((a, b) => b[1].length - a[1].length)[0];
      const chosen =
        (push && !config.pushurl ? rewrite(".pushinsteadof") : undefined) ||
        rewrite(".insteadof");
      value = chosen
        ? chosen[0].slice(4, chosen[0].lastIndexOf(".")) +
          original.slice(chosen[1].length)
        : original;
    } else {
      const values = (
        await git(
          runner,
          ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"],
          cwd,
          env,
        )
      )
        .trim()
        .split("\n");
      if (values.length !== 1) throw policyError();
      value = values[0];
    }
    result.push(
      await canonicalEndpoint(
        value,
        owner,
        runner,
        isolatedEnvironment(env.HOME || "/dev/null"),
      ),
    );
  }
  return result;
}
/** Physical trust is independent of the environment used by a future command. */
async function checkedPhysicalPolicy(
  home: string,
  runner: Pick<Runner, "command">,
  owner: WorktreeRecord,
): Promise<UpstreamPolicy> {
  try {
    const env = isolatedEnvironment(home),
      policy = await readPolicy(owner),
      source = await originConfig(runner, owner.projectPath, env),
      clone = await originConfig(runner, owner.path, env);
    if (
      !policy ||
      !source ||
      !clone ||
      policy.contextId !== owner.contextId ||
      policy.ownerHash !== (await ownerHash(owner)) ||
      policy.primaryHash !== hash(JSON.stringify(source)) ||
      policy.cloneHash !== hash(JSON.stringify(clone))
    )
      throw policyError();
    return policy;
  } catch (error) {
    if (error instanceof RunnerShutdownError) throw error;
    throw policyError();
  }
}
async function checkedPolicy(
  home: string,
  runner: Pick<Runner, "command">,
  owner: WorktreeRecord,
  nativeEnv: NodeJS.ProcessEnv,
): Promise<UpstreamPolicy> {
  try {
    const policy = await checkedPhysicalPolicy(home, runner, owner);
    const sourceEndpoints = await endpoints(
        runner,
        owner.projectPath,
        owner,
        nativeEnv,
      ),
      cloneEndpoints = await endpoints(runner, owner.path, owner, nativeEnv);
    if (
      JSON.stringify(sourceEndpoints) !== JSON.stringify(cloneEndpoints) ||
      policy.endpointsHash !== hash(JSON.stringify(sourceEndpoints))
    )
      throw policyError();
    return policy;
  } catch {
    throw policyError();
  }
}
/**
 * Physical allowlist for CloneManager; merely adding origin never grants trust.
 * Do not resolve native endpoints here: discovery has no final project child
 * environment. Publication prepare/verify rechecks them with that exact env.
 */
export async function assertClonePublicationOrigin(
  home: string,
  runner: Pick<Runner, "command">,
  owner: WorktreeRecord,
) {
  const config = await originConfig(
    runner,
    owner.path,
    isolatedEnvironment(home),
  );
  if (!config) {
    if (await readPolicy(owner)) throw policyError();
    return;
  }
  if (config.url === owner.projectPath) {
    await assertLocalOrigin(owner, (args, cwd) =>
      git(runner, args, cwd, isolatedEnvironment(home)),
    );
    return;
  }
  await checkedPhysicalPolicy(home, runner, owner);
}
/** Incoming transport never changes primary refs/HEAD/index/files, or clone checkout. */
export class ContextExchangeManager {
  private readonly clones: CloneStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly bases = new Map<
    string,
    { snapshot: BaseSnapshot; cleanRequired: boolean }
  >();
  private readonly publications = new Map<string, PublicationSnapshot>();
  constructor(
    readonly home: string,
    readonly runner: Pick<Runner, "command">,
    readonly deps: ContextExchangeDependencies,
  ) {
    this.clones = new CloneStore(home);
    this.env = isolatedEnvironment(home);
  }
  private git(args: string[], cwd: string) {
    return git(this.runner, args, cwd, this.env);
  }
  private async owner(input: TopicContextRef, lockedOwner?: WorktreeRecord) {
    const ref = topicContextRefSchema.parse(input);
    // CloneManager.resolve acquires this same repository lock. While holding it,
    // recheck the registry directly instead of recursively calling the resolver.
    const owner = worktreeRecordSchema.parse(
      lockedOwner
        ? (await this.clones.read()).records.find(
            (record) => record.contextId === ref.contextId,
          )
        : await this.deps.resolve(ref),
    );
    if (lockedOwner && JSON.stringify(owner) !== JSON.stringify(lockedOwner))
      throw changed();
    if (
      JSON.stringify(worktreeContextRef(owner)) !== JSON.stringify(ref) ||
      owner.storageKind !== "clone" ||
      owner.ownership !== "managed" ||
      owner.state !== "ready" ||
      owner.deletedAt ||
      !owner.sourceCommonDir
    )
      throw changed();
    await this.clones.assertOwned(owner);
    for (const [cwd, common] of [
      [owner.projectPath, owner.sourceCommonDir],
      [owner.path, owner.gitCommonDir],
    ]) {
      if (
        (await realpath(cwd)) !== cwd ||
        (await realpath(common)) !== common ||
        (await this.git(["rev-parse", "--show-toplevel"], cwd)).trim() !==
          cwd ||
        (await this.git(["rev-parse", "--absolute-git-dir"], cwd)).trim() !==
          common ||
        (
          await this.git(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd,
          )
        ).trim() !== common
      )
        throw changed();
    }
    if (
      (await this.git(["symbolic-ref", "HEAD"], owner.path)).trim() !==
      `refs/heads/${owner.branch}`
    )
      throw changed();
    return owner;
  }
  private async available(owner: WorktreeRecord, cleanRequired = true) {
    if (
      this.deps.isActive(owner.contextId) ||
      this.deps.isProjectActive?.(owner.projectId)
    )
      throw new Error(
        "Контекст или основная папка заняты активной операцией. Повторите после завершения.",
      );
    if (
      cleanRequired &&
      (
        await this.git(
          ["status", "--porcelain=v1", "--untracked-files=all"],
          owner.path,
        )
      ).trim()
    )
      throw new Error(
        "В клоне есть локальные изменения. Нужна чистая рабочая копия; сохраните изменения и повторите.",
      );
  }
  private async resolveBase(owner: WorktreeRecord, baseRef: string) {
    if (
      !baseRef ||
      baseRef.length > 1024 ||
      baseRef.startsWith("-") ||
      /[\x00-\x20\x7f]/.test(baseRef)
    )
      throw changed();
    try {
      return oid(
        await this.git(
          ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
          owner.projectPath,
        ),
      );
    } catch {
      throw new Error(
        "Выбранная база основной папки отсутствует или изменена. Выберите существующий ref и повторите.",
      );
    }
  }
  private async capture(
    owner: WorktreeRecord,
    baseRef: string,
    cleanRequired = true,
  ): Promise<BaseSnapshot> {
    await this.owner(worktreeContextRef(owner), owner);
    await this.available(owner, cleanRequired);
    const sourceOid = await this.resolveBase(owner, baseRef),
      id = randomUUID();
    const snapshot: BaseSnapshot = {
      id,
      owner: worktreeContextRef(owner),
      baseRef,
      sourceOid,
      cloneRef: `refs/desktop/bases/${owner.contextId}/${id}`,
      cloneHead: oid(
        await this.git(["rev-parse", "--verify", "HEAD^{commit}"], owner.path),
      ),
    };
    // Git fetch addresses an immutable object, never a movable source branch.
    try {
      await this.clones.assertOwned(owner);
      if (
        (
          await this.git(
            ["ls-remote", "--get-url", owner.projectPath],
            owner.path,
          )
        ).trim() !== owner.projectPath
      )
        throw changed();
      await this.git(
        [
          "fetch",
          "--no-tags",
          "--no-write-fetch-head",
          "--no-auto-gc",
          "--",
          owner.projectPath,
          sourceOid,
        ],
        owner.path,
      );
      await this.clones.assertOwned(owner);
      // Create-only CAS: even a UUID collision may not overwrite an old ref.
      await this.git(
        [
          "update-ref",
          snapshot.cloneRef,
          sourceOid,
          "0".repeat(sourceOid.length),
        ],
        owner.path,
      );
      await this.clones.assertOwned(owner);
      if (
        oid(
          await this.git(
            ["rev-parse", "--verify", `${snapshot.cloneRef}^{commit}`],
            owner.path,
          ),
        ) !== sourceOid ||
        (await this.resolveBase(owner, baseRef)) !== sourceOid
      )
        throw changed();
      await this.available(owner, cleanRequired);
      if (
        oid(
          await this.git(
            ["rev-parse", "--verify", "HEAD^{commit}"],
            owner.path,
          ),
        ) !== snapshot.cloneHead
      )
        throw changed();
    } catch {
      throw new Error(
        "Не удалось получить неизменяемый снимок базы: контекст или база изменены. Повторите подготовку; основная папка не изменялась.",
      );
    }
    await this.owner(worktreeContextRef(owner), owner);
    this.bases.set(id, { snapshot: structuredClone(snapshot), cleanRequired });
    return snapshot;
  }
  async captureBase(
    ref: TopicContextRef,
    baseRef: string,
  ): Promise<BaseSnapshot> {
    const owner = await this.owner(ref);
    return this.clones.withRepositoryLock(owner.repositoryKey, () =>
      this.capture(owner, baseRef),
    );
  }
  async verifyBase(snapshot: BaseSnapshot): Promise<void> {
    return this.verifyCapturedBase(snapshot);
  }
  private async verifyCapturedBase(
    snapshot: BaseSnapshot,
    lockedOwner?: WorktreeRecord,
  ): Promise<void> {
    const original = this.bases.get(snapshot.id);
    if (
      !original ||
      JSON.stringify(snapshot) !== JSON.stringify(original.snapshot)
    )
      throw changed();
    const owner = await this.owner(snapshot.owner, lockedOwner);
    await this.available(owner, original.cleanRequired);
    try {
      if (
        (await this.resolveBase(owner, snapshot.baseRef)) !==
          snapshot.sourceOid ||
        oid(
          await this.git(
            ["rev-parse", "--verify", `${snapshot.cloneRef}^{commit}`],
            owner.path,
          ),
        ) !== snapshot.sourceOid ||
        oid(
          await this.git(
            ["rev-parse", "--verify", "HEAD^{commit}"],
            owner.path,
          ),
        ) !== snapshot.cloneHead
      )
        throw changed();
    } catch {
      throw changed();
    }
  }
  private async nativeEnvironment(ref: TopicContextRef) {
    return childEnvironment(
      process.env,
      { HOME: this.home },
      await this.deps.nativeEnvironment?.(ref),
    );
  }
  private async propagationBase(owner: WorktreeRecord, selected: string) {
    const inventory = (
      await this.git(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          "refs/heads",
          "refs/remotes/origin",
        ],
        owner.projectPath,
      )
    )
      .trim()
      .split("\n")
      .map((row) => row.split("\0"));
    const local = inventory.find(([name]) => name === `refs/heads/${selected}`);
    let name = local
      ? selected
      : selected.startsWith("refs/heads/")
        ? selected.slice(11)
        : selected.startsWith("refs/remotes/origin/")
          ? selected.slice(20)
          : selected.startsWith("origin/")
            ? selected.slice(7)
            : selected;
    if (
      !inventory.some(
        ([ref]) =>
          ref === `refs/heads/${name}` || ref === `refs/remotes/origin/${name}`,
      ) ||
      name === owner.branch
    )
      throw new Error(
        "Для propagate нужна настоящая базовая ветка, отличная от текущего топика, а не tag/hash/service ref.",
      );
    await this.git(["check-ref-format", `refs/heads/${name}`], owner.path);
    const worktrees = await this.git(
      ["worktree", "list", "--porcelain", "-z"],
      owner.path,
    );
    if (worktrees.split("\0").includes(`branch refs/heads/${name}`))
      throw new Error(
        "Базовая ветка занята рабочей копией. Переключитесь с базы и повторите.",
      );
    const sourceOid = await this.resolveBase(owner, selected);
    const refs = (
      await this.git(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)",
          `refs/heads/${name}`,
        ],
        owner.path,
      )
    )
      .trim()
      .split("\n")
      .map((row) => row.split("\0"));
    const previous = refs.find(([ref]) => ref === `refs/heads/${name}`)?.[1];
    return { name, previous, sourceOid };
  }
  async preparePublication(
    ref: TopicContextRef,
    input: { action: "publish" | "update" | "propagate"; baseRef?: string },
  ): Promise<PublicationSnapshot> {
    if (!["publish", "update", "propagate"].includes(input.action))
      throw policyError();
    const owner = await this.owner(ref);
    // The callback may resolve the owner via CloneManager and must run before
    // acquiring the repository lock. Execution performs a fresh callback check.
    const nativeEnv = await this.nativeEnvironment(ref);
    return this.clones.withRepositoryLock(owner.repositoryKey, async () => {
      await this.owner(ref, owner);
      await this.available(owner, input.action === "update");
      const currentOrigin = await originConfig(
        this.runner,
        owner.path,
        this.env,
      );
      if (!currentOrigin || currentOrigin.url === owner.projectPath)
        throw new Error(
          "Origin копии предназначен для исходного локального проекта. Используйте синхронизацию для push в локальный origin; внешняя публикация через этот origin не поддерживается.",
        );
      let policy: UpstreamPolicy;
      try {
        const source = await originConfig(
          this.runner,
          owner.projectPath,
          this.env,
        );
        if (!source) throw policyError();
        const actual = await endpoints(
          this.runner,
          owner.projectPath,
          owner,
          nativeEnv,
        );
        const desired: OriginConfig = {
          url: source.url,
          ...(source.pushurl ? { pushurl: source.pushurl } : {}),
          fetch: "+refs/heads/*:refs/remotes/origin/*",
        };
        // Evaluate clone rewrites under its actual native environment before writing any config.
        if (
          JSON.stringify(
            await endpoints(this.runner, owner.path, owner, nativeEnv, desired),
          ) !== JSON.stringify(actual)
        )
          throw policyError();
        // Only an already trusted legacy external-origin policy remains supported.
        // New/legacy originless copies must never inherit the primary's upstream.
        policy = await checkedPolicy(this.home, this.runner, owner, nativeEnv);
        // Validate branch shape/divergence before enabling publication or fetching base objects.
        const propagation =
          input.action === "propagate"
            ? await this.propagationBase(owner, input.baseRef || "")
            : undefined;
        const base = propagation
          ? await this.capture(owner, input.baseRef!, false)
          : undefined;
        if (propagation && base) {
          if (base.sourceOid !== propagation.sourceOid) throw changed();
          if (
            propagation.previous &&
            propagation.previous !== propagation.sourceOid
          ) {
            try {
              await this.git(
                [
                  "merge-base",
                  "--is-ancestor",
                  propagation.previous,
                  propagation.sourceOid,
                ],
                owner.path,
              );
            } catch {
              throw new Error(
                "База клона и выбранная база расходятся. Согласуйте ветки вручную; reset/force не выполнялись.",
              );
            }
          }
          await this.verifyCapturedBase(base, owner);
        }
        await this.owner(ref, owner);
        await this.available(owner, input.action === "update");
        if (
          hash(
            JSON.stringify(
              await originConfig(this.runner, owner.projectPath, this.env),
            ),
          ) !== policy.primaryHash ||
          hash(
            JSON.stringify(
              await endpoints(this.runner, owner.projectPath, owner, nativeEnv),
            ),
          ) !== policy.endpointsHash
        )
          throw policyError();
        policy = await checkedPolicy(this.home, this.runner, owner, nativeEnv);
        const snapshot: PublicationSnapshot = {
          id: randomUUID(),
          owner: worktreeContextRef(owner),
          action: input.action,
          policyHash: hash(JSON.stringify(policy)),
          cloneHead: oid(
            await this.git(
              ["rev-parse", "--verify", "HEAD^{commit}"],
              owner.path,
            ),
          ),
          details: [
            `Публикация: origin → ${maskedEndpoint(actual[1])}. Проверенный upstream основной папки, не основная рабочая папка.`,
          ],
        };
        if (propagation) {
          snapshot.base = base;
          await this.verifyCapturedBase(base!, owner);
          if (propagation.previous !== propagation.sourceOid)
            await this.git(
              [
                "update-ref",
                `refs/heads/${propagation.name}`,
                propagation.sourceOid,
                propagation.previous ||
                  "0".repeat(propagation.sourceOid.length),
              ],
              owner.path,
            );
          snapshot.baseRef = propagation.name;
          snapshot.details.push(
            `База клона ${propagation.name}: ${propagation.previous ? "безопасный fast-forward" : "создана из основной папки"} до ${propagation.sourceOid.slice(0, 12)}; native propagate обновит эту настоящую ветку и отправит её в upstream origin.`,
          );
        }
        await this.clones.assertOwned(owner);
        await this.available(owner, input.action === "update");
        this.publications.set(snapshot.id, structuredClone(snapshot));
        return snapshot;
      } catch (error) {
        // Never surface child argv/stderr or remote credentials through Desktop journals.
        if (
          error instanceof Error &&
          /расход|настоящая базовая|Базовая ветка занята|чистая рабочая|заняты активной|изменены\/устарели/.test(
            error.message,
          )
        )
          throw error;
        throw policyError();
      }
    });
  }
  async verifyPublication(snapshot: PublicationSnapshot): Promise<void> {
    const original = this.publications.get(snapshot.id);
    if (!original || JSON.stringify(snapshot) !== JSON.stringify(original))
      throw changed();
    const owner = await this.owner(snapshot.owner);
    await this.available(owner, snapshot.action === "update");
    const policy = await checkedPolicy(
      this.home,
      this.runner,
      owner,
      await this.nativeEnvironment(snapshot.owner),
    );
    if (
      hash(JSON.stringify(policy)) !== snapshot.policyHash ||
      oid(
        await this.git(["rev-parse", "--verify", "HEAD^{commit}"], owner.path),
      ) !== snapshot.cloneHead
    )
      throw changed();
    if (snapshot.base) {
      await this.verifyBase(snapshot.base);
      if (
        !snapshot.baseRef ||
        oid(
          await this.git(
            [
              "rev-parse",
              "--verify",
              `refs/heads/${snapshot.baseRef}^{commit}`,
            ],
            owner.path,
          ),
        ) !== snapshot.base.sourceOid
      )
        throw changed();
    }
  }
}
