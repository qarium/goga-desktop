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
  sync(
    project: Project,
    ref: TopicContextRef,
    onDiagnostic: (stdout: string, stderr: string) => void,
  ): Promise<ContextSyncState>;
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>;
  goga(args: string[]): Promise<{ stdout: string; stderr: string }>;
  gogaOriginal(args: string[]): Promise<{ stdout: string; stderr: string }>;
  verify(): Promise<void>;
  secrets: string[];
}
const changed = () =>
  Error(
    "Владелец, ветка или настройки Git изменились. Повторите действие после проверки.",
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
      text = text.split(variant).join("[скрыто]");
  }
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[скрыто]@")
    .replace(
      /([?&](?:token|password|secret|key|access_token)=)[^\s&#]+/gi,
      "$1[скрыто]",
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
    error instanceof Error ? error.message : "Операция не выполнена.",
    secrets,
  );
  return {
    projectId: request.projectId,
    ...(request.context ? { contextId: request.context.contextId } : {}),
    action: request.action,
    status: "error",
    log: sanitizeRepositoryLog(`${log}\nОшибка: ${message}`, secrets),
    error: message.split("\n")[0].slice(0, 500),
  };
}

/** Host-only orchestration; the service supplies serialized, settings-bound capabilities. */
export class RepositoryActions {
  private lines: string[] = [];
  private owner?: WorktreeRecord;
  private project!: Project;
  private common = "";
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
  private async verify() {
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
    if (this.owner) {
      const current = await this.deps.resolve(worktreeContextRef(this.owner));
      if (JSON.stringify(current) !== JSON.stringify(this.owner))
        throw changed();
    }
  }
  private async currentBranch() {
    const ref = (await this.git(["symbolic-ref", "--quiet", "HEAD"])).trim();
    if (!ref.startsWith("refs/heads/"))
      throw Error(
        "В основной папке не выбрана локальная ветка (detached HEAD).",
      );
    return ref.slice(11);
  }
  private async directBranch(value: string) {
    const branch = value.startsWith("refs/heads/") ? value.slice(11) : value;
    if (
      !branch ||
      branch.startsWith("-") ||
      branch.startsWith("refs/") ||
      /[\x00-\x20\x7f]/.test(branch)
    )
      throw Error(
        "База должна быть однозначной локальной веткой, не тегом или произвольной ссылкой.",
      );
    const ref = `refs/heads/${branch}`;
    await this.git(["check-ref-format", ref]);
    const rows = (
      await this.git([
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)",
        ref,
        `refs/tags/${branch}`,
      ])
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
        "Базовая ветка отсутствует, символическая или неоднозначна с тегом.",
      );
    return { branch, ref, oid: oid(match[1]) };
  }
  private async remote(name: string, push: boolean) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(name) || name === ".")
      throw Error("Upstream remote отсутствует или неоднозначен.");
    const prefix = `remote.${name}.`;
    const raw = await this.git([
      "config",
      "--local",
      "--includes",
      "--null",
      "--list",
    ]);
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
        `Remote ${name} отсутствует или содержит небезопасные настройки.`,
      );
    for (const key of ["url", "pushurl", "fetch"]) {
      const values = rows.filter(([k]) => k === prefix + key);
      if (values.length > 1 || (key === "url" && values.length !== 1))
        throw Error(`Remote ${name} неоднозначен.`);
    }
    const endpoint = (
      await this.git([
        "remote",
        "get-url",
        ...(push ? ["--push"] : []),
        "--all",
        name,
      ])
    ).trim();
    if (
      !endpoint ||
      endpoint.startsWith("-") ||
      /[\x00-\x20\x7f]/.test(endpoint) ||
      endpoint.includes("::")
    )
      throw Error(`Remote ${name} содержит недопустимый адрес.`);
    return JSON.stringify([rows, endpoint]);
  }
  private async publish(branch: string, expected?: string) {
    this.lines.push(
      `Публикация ветки ${branch} из оригинального проекта в origin…`,
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
    this.lines.push("Публикация завершена.");
  }
  private async refreshBase(value: string) {
    const base = await this.directBranch(value);
    const assertIdle = async () => {
      const gitDir = (
        await this.git(["rev-parse", "--absolute-git-dir"])
      ).trim();
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
          "В оригинальном репозитории уже идёт операция Git; обновление базы не выполнено.",
        );
      }
      for (const file of ["packed-refs.lock", `${base.ref}.lock`]) {
        const full = path.join(this.common, file);
        await noSymlinks(full);
        try {
          await lstat(full);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw Error("Базовая ветка занята операцией Git.");
      }
    };
    await assertIdle();
    this.lines.push(
      `Обновление базовой ветки ${base.branch} из upstream (fast-forward-only)…`,
    );
    const upstream = async () =>
      (
        await this.git([
          "for-each-ref",
          "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)",
          base.ref,
        ])
      )
        .trim()
        .split("\n")
        .map((row) => row.split("\0"))
        .find((row) => row[0] === base.ref);
    const tracking = await upstream();
    if (!tracking?.[1] || !tracking[2]?.startsWith("refs/heads/"))
      throw Error(`У ветки ${base.branch} отсутствует однозначный upstream.`);
    await this.git(["check-ref-format", tracking[2]]);
    const endpoint = await this.remote(tracking[1], false);
    const verify = async () => {
      await this.verify();
      await assertIdle();
      if (
        JSON.stringify(await upstream()) !== JSON.stringify(tracking) ||
        (await this.remote(tracking[1], false)) !== endpoint ||
        (await this.directBranch(base.branch)).oid !== base.oid
      )
        throw changed();
    };
    await verify();
    const fetched = `refs/desktop/repository-actions/${randomUUID()}`;
    await this.git(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        tracking[1],
        `${tracking[2]}:${fetched}`,
      ],
      this.project.path,
      true,
    );
    let next = oid(
      await this.git(["rev-parse", "--verify", `${fetched}^{commit}`]),
    );
    try {
      await this.git(["merge-base", "--is-ancestor", base.oid, next]);
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
      // A local branch ahead of upstream is already up to date; never reset it backwards.
      try {
        await this.git(["merge-base", "--is-ancestor", next, base.oid]);
      } catch (reverseError) {
        if (
          !(reverseError instanceof CommandExitError) ||
          reverseError.exitCode !== 1
        )
          throw reverseError;
        throw Error(
          `Истории базовой ветки ${base.branch} и upstream разошлись. Выполните слияние или другую проверенную операцию вручную; fast-forward-only не изменял ветку.`,
        );
      }
      next = base.oid;
    }
    await verify();
    const worktrees = (
      await this.git(["worktree", "list", "--porcelain", "-z"])
    ).split("\0\0");
    const elsewhere = worktrees.some(
      (block) =>
        block.split("\0").includes(`branch ${base.ref}`) &&
        !block.split("\0").includes(`worktree ${this.project.path}`),
    );
    if (elsewhere)
      throw Error(
        "Базовая ветка открыта в другой рабочей копии; обновите её там вручную.",
      );
    const head = (
      await this.git(["rev-parse", "--symbolic-full-name", "HEAD"])
    ).trim();
    await verify();
    if (head === base.ref) {
      if ((await this.currentBranch()) !== base.branch) throw changed();
      await this.git(
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
        this.project.path,
        true,
      );
    } else {
      await this.git(
        ["update-ref", "--no-deref", base.ref, next, base.oid],
        this.project.path,
        true,
      );
    }
    await this.verify();
    if ((await this.directBranch(base.branch)).oid !== next) throw changed();
    this.lines.push(`Базовая ветка ${base.branch} обновлена.`);
    return { ...base, oid: next };
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
        "Базовая ссылка origin в клоне символическая; обновление запрещено.",
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
    this.lines.push(`База origin/${branch} в клоне обновлена.`);
  }
  async run(request: RepositoryActionRequest): Promise<RepositoryActionResult> {
    try {
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
      if (request.action === "propagate" && !this.owner)
        throw Error(
          "Применение топика к базе доступно только в выбранном контексте топика.",
        );
      if (
        this.owner &&
        !(await assertLocalOrigin(this.owner, (args, cwd) =>
          this.git(args, cwd),
        ))
      )
        throw Error(
          "У клона отсутствует локальный origin; настройки не изменялись.",
        );
      if (request.action === "update-base") {
        if (!this.owner)
          throw Error("Обновление из базовой ветки доступно только в топике.");
        this.lines.push(
          "Чтение эффективной конфигурации: goga config topics (клон)…",
        );
        const output = await this.deps.goga(["config", "topics"]);
        const document = parseDocument(output.stdout, { uniqueKeys: true });
        if (document.errors.length)
          throw Error("Некорректная эффективная конфигурация topics.");
        const parsed = z
          .object({
            base_ref: z.string().min(1),
            update: z.object({ strategy: z.string().optional() }).optional(),
          })
          .safeParse(document.toJS({ maxAliasCount: 10 }));
        if (!parsed.success)
          throw Error(
            "В эффективной конфигурации topics отсутствует base_ref или неверен тип/стратегия update.",
          );
        const base = await this.refreshBase(parsed.data.base_ref);
        await this.verify();
        if (
          !(await assertLocalOrigin(this.owner, (args, cwd) =>
            this.git(args, cwd),
          ))
        )
          throw Error("У клона отсутствует локальный origin.");
        const cloneRef = `refs/desktop/repository-actions/${randomUUID()}`;
        this.lines.push("Получение обновлённой базы в клон…");
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
        await assertLocalOrigin(this.owner, (args, cwd) => this.git(args, cwd));
        this.lines.push(
          "Обновление топика: goga topics update (клон, без публикации)…",
        );
        // Native Goga reads topics.update.strategy itself; there is no --strategy option.
        const result = await this.deps.goga([
          "topics",
          "--year",
          this.owner.year,
          "update",
          this.owner.branch,
          "--base-ref",
          cloneRef,
        ]);
        this.lines.push(
          result.stdout,
          result.stderr,
          "Обновление топика завершено.",
        );
      } else if (this.owner) {
        this.lines.push("Синхронизация топика в локальный origin…");
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
              "Синхронизация не завершена; следующие шаги не выполнялись.",
          );
        this.lines.push("Синхронизация топика завершена.");
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
          this.lines.push(
            "Применение топика к базе: goga topics propagate (оригинальный проект, с публикацией базы)…",
          );
          // Native Goga owns base selection, merge strategy and base publication.
          const propagated = await this.deps.gogaOriginal([
            "topics",
            "--year",
            this.owner.year,
            "propagate",
            this.owner.branch,
            "-y",
          ]);
          this.lines.push(
            propagated.stdout,
            propagated.stderr,
            "Применение топика к базе завершено.",
          );
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
