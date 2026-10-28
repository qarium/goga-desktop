import path from "node:path";
import os from "node:os";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import {
  withNativeGitIndex,
  withNativeGitObjects,
  withNativeGitIndexRefresh,
} from "./git-index-scope";
import { noSymlinks } from "./settings";
import type { Runner, ByteCommandResult } from "./process";
import { ByteCommandError } from "./process";
import {
  nativeGitArguments,
  withNativeGitPolicy,
  type NativeGitRequest,
  type NativeGitPolicy,
} from "./git-native-policy";

export interface NativeGitDiagnostic {
  gitVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  policy: NativeGitPolicy;
  command: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processSettled: boolean;
}
interface Options {
  runner: Pick<Runner, "commandBytes">;
  /** Resolved by the host once, never an executable selected by the renderer. */
  executable: string;
  root: string;
  env?: NodeJS.ProcessEnv;
  /** Frozen effective config already validated by the operation admission. */
  configuration?: readonly (readonly [string, string])[];
  report?: (event: NativeGitDiagnostic) => void;
}

/** One native process attempt. Nonzero exit is data for the operation verifier,
 * not success, automatic retry, or proof of a conflict/rollback. */
export interface NativeGitClient {
  gitVersion: string;
  run(request: NativeGitRequest): Promise<ByteCommandResult>;
  inTemporaryIndex<T>(
    action: (
      client: Pick<NativeGitClient, "run"> & {
        refreshSourceIndex(): Promise<ByteCommandResult>;
      },
      directory: string,
    ) => Promise<T>,
    /** Native metadata + immutable flattened config; private HEAD/ref only. */
    frozen?: boolean,
  ): Promise<T>;
  inTemporaryRepository<T>(
    action: (client: NativeGitClient, root: string) => Promise<T>,
  ): Promise<T>;
}
function requireSettled(result: ByteCommandResult) {
  if (!result.processSettled || result.signal !== null)
    throw new ByteCommandError(
      "process-unsettled",
      result.processSettled,
      result.stdout,
      result.stderr,
      result.exitCode,
      result.signal,
    );
}
export async function createNativeGitClient(
  options: Options,
): Promise<NativeGitClient> {
  const command = options.runner.commandBytes?.bind(options.runner);
  if (
    !command ||
    !path.isAbsolute(options.executable) ||
    !path.isAbsolute(options.root) ||
    options.executable.includes("\0") ||
    options.root.includes("\0")
  )
    throw Error("Исполнитель штатного Git недоступен или контекст недопустим.");
  const executable = options.executable,
    root = options.root,
    env = Object.freeze({ ...options.env }),
    config = (options.configuration ?? []).map(
      ([key, value]) => [key, value] as const,
    );
  const version = await withNativeGitPolicy("local-read", () =>
    command({
      executable,
      cwd: root,
      env,
      args: nativeGitArguments({ policy: "local-read", command: "--version" }),
    }),
  );
  requireSettled(version);
  const gitVersion =
    /^git version (\d+\.\d+(?:\.\d+)?)(?:[ .()A-Za-z0-9+-]*)\r?\n?$/.exec(
      version.stdout.toString("utf8"),
    )?.[1];
  if (version.exitCode !== 0 || !gitVersion)
    throw Error("Не удалось определить версию штатного Git.");
  const report = (
    request: NativeGitRequest,
    started: number,
    result?: ByteCommandResult,
    error?: unknown,
  ) => {
    try {
      options.report?.({
        gitVersion,
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        policy: request.policy,
        command: request.command,
        durationMs: Math.max(0, performance.now() - started),
        exitCode:
          result?.exitCode ??
          (error instanceof ByteCommandError ? error.exitCode : null),
        signal:
          result?.signal ??
          (error instanceof ByteCommandError ? error.signal : null),
        processSettled:
          result?.processSettled ??
          (error instanceof ByteCommandError && error.processSettled),
      });
    } catch {
      /* Diagnostics cannot change a completed operation or cause retry. */
    }
  };
  return Object.freeze({
    gitVersion,
    async inTemporaryIndex<T>(
      action: (
        client: Pick<NativeGitClient, "run"> & {
          refreshSourceIndex(): Promise<ByteCommandResult>;
        },
        directory: string,
      ) => Promise<T>,
      frozen = false,
    ): Promise<T> {
      const temp = await fs.realpath(os.tmpdir());
      if (temp === root || temp.startsWith(root + path.sep))
        throw Error("Временный индекс не может находиться внутри проекта.");
      const directory = await fs.mkdtemp(path.join(temp, "goga-native-index-"));
      const index = path.join(directory, "index");
      const owned = await fs.lstat(directory);
      const assertDirectory = async () => {
        await noSymlinks(directory);
        const current = await fs.lstat(directory);
        if (
          !current.isDirectory() ||
          current.dev !== owned.dev ||
          current.ino !== owned.ino
        )
          throw Error("Владелец временного индекса Git изменился.");
      };
      let settled = true;
      const base = this;
      const gitdir = path.join(directory, ".git");
      const objects = path.join(root, ".git/objects");
      const frozenConfig = config
        .filter(
          ([key]) =>
            !/^(include|includeif|filter)\./i.test(key) &&
            ![
              "core.worktree",
              "core.bare",
              "extensions.worktreeconfig",
            ].includes(key.toLowerCase()),
        )
        .map(
          ([key, value]) =>
            [
              key,
              key.toLowerCase() === "core.attributesfile" &&
              value &&
              !path.isAbsolute(value) &&
              !value.startsWith("~")
                ? path.resolve(root, value)
                : value,
            ] as const,
        );
      let objectIdentity: { dev: number; ino: number } | undefined;
      let metadataIdentity: { dev: number; ino: number } | undefined;
      const assertMetadata = async () => {
        await assertDirectory();
        await noSymlinks(gitdir);
        const actual = await fs.lstat(gitdir);
        if (
          !actual.isDirectory() ||
          actual.dev !== metadataIdentity?.dev ||
          actual.ino !== metadataIdentity?.ino
        )
          throw Error("Временные метаданные Git изменились.");
      };
      const invoke = async (
        request: NativeGitRequest,
        initializing = false,
      ) => {
        try {
          let result: ByteCommandResult;
          if (!frozen) result = await base.run(request);
          else {
            await assertDirectory();
            if (!initializing) {
              await assertMetadata();
              await noSymlinks(objects);
              const actual = await fs.lstat(objects);
              if (
                !actual.isDirectory() ||
                actual.dev !== objectIdentity?.dev ||
                actual.ino !== objectIdentity?.ino
              )
                throw Error("Хранилище объектов Git изменилось.");
            }
            result = await withNativeGitPolicy(request.policy, () =>
              command({
                executable,
                env,
                cwd: initializing ? directory : root,
                args: [
                  ...(!initializing
                    ? [`--git-dir=${gitdir}`, `--work-tree=${root}`]
                    : []),
                  ...nativeGitArguments(
                    request,
                    initializing ? [] : frozenConfig,
                  ),
                ],
                stdin: request.stdin && Buffer.from(request.stdin),
                ...("verifyPrepared" in request && request.verifyPrepared
                  ? { verifyPrepared: request.verifyPrepared }
                  : {}),
              }),
            );
          }
          if (!result.processSettled) settled = false;
          return result;
        } catch (error) {
          if (!(error instanceof ByteCommandError) || !error.processSettled)
            settled = false;
          throw error;
        }
      };
      try {
        if (frozen) {
          await noSymlinks(objects);
          const identity = await fs.lstat(objects);
          if (!identity.isDirectory())
            throw Error("Недопустимое хранилище объектов Git.");
          objectIdentity = identity;
          const format = await base.run({
            policy: "local-read",
            command: "rev-parse",
            args: ["--show-object-format"],
          });
          requireSettled(format);
          const value = format.stdout.toString("utf8").trim();
          if (format.exitCode !== 0 || !["sha1", "sha256"].includes(value))
            throw Error("Неизвестный формат объектов Git.");
          const init = await invoke(
            {
              policy: "local-write",
              command: "init",
              args: [
                "--template=",
                "--initial-branch=goga-private",
                `--object-format=${value}`,
              ],
            },
            true,
          );
          requireSettled(init);
          if (init.exitCode !== 0)
            throw Error("Не удалось подготовить временный индекс Git.");
          await assertDirectory();
          await noSymlinks(gitdir);
          metadataIdentity = await fs.lstat(gitdir);
          await assertMetadata();
          // info/attributes is a documented text interface. Never copy an index,
          // refs or object bytes; native Git owns all such metadata.
          const attributes = path.join(root, ".git/info/attributes");
          await noSymlinks(attributes);
          const handle = await fs
            .open(
              attributes,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            )
            .catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
          if (handle)
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
                throw Error("Недопустимые attributes Git.");
              const bytes = Buffer.alloc(stat.size + 1);
              const read = await handle.read(bytes, 0, bytes.length, 0);
              const after = await handle.stat();
              if (
                read.bytesRead !== stat.size ||
                after.size !== stat.size ||
                after.mtimeMs !== stat.mtimeMs ||
                after.ctimeMs !== stat.ctimeMs
              )
                throw Error("Attributes Git изменились.");
              await assertMetadata();
              const infoDirectory = path.join(gitdir, "info");
              await noSymlinks(infoDirectory);
              await fs.mkdir(infoDirectory, { mode: 0o700 }).catch((error) => {
                if (error.code !== "EEXIST") throw error;
              });
              await noSymlinks(infoDirectory);
              if (!(await fs.lstat(infoDirectory)).isDirectory())
                throw Error("Небезопасный каталог attributes Git.");
              await fs.writeFile(
                path.join(infoDirectory, "attributes"),
                bytes.subarray(0, stat.size),
                { flag: "wx", mode: 0o600 },
              );
            } finally {
              await handle.close();
            }
        }
        return await action(
          {
            // index-info intentionally leaves stat data empty. Native reset
            // --merge (used by cherry-pick/revert --abort) requires a refreshed
            // index. Refresh through Git with frozen, filter-free metadata;
            // never run refresh against the live repository configuration.
            refreshSourceIndex: async () => {
              if (!frozen)
                throw Error(
                  "Обновление индекса требует изолированной конфигурации.",
                );
              await assertMetadata();
              const sourceIndex = path.join(root, ".git/index");
              await noSymlinks(sourceIndex);
              const info = await fs.lstat(sourceIndex);
              if (!info.isFile() || info.nlink !== 1)
                throw Error("Небезопасный индекс Git.");
              return withNativeGitIndexRefresh(root, () =>
                withNativeGitObjects(objects, () =>
                  invoke({
                    policy: "local-write",
                    command: "update-index",
                    args: ["--refresh", "--unmerged", "--ignore-missing"],
                  }),
                ),
              );
            },
            run: async (request) => {
              await assertDirectory();
              await noSymlinks(index);
              const info = await fs.lstat(index).catch((error) => {
                if (error.code === "ENOENT") return null;
                throw error;
              });
              if (info && (!info.isFile() || info.nlink !== 1))
                throw Error("Небезопасный временный индекс Git.");
              try {
                const result = await withNativeGitIndex(index, () =>
                  frozen
                    ? withNativeGitObjects(objects, () => invoke(request))
                    : invoke(request),
                );
                if (!result.processSettled) settled = false;
                return result;
              } catch (error) {
                if (
                  !(error instanceof ByteCommandError) ||
                  !error.processSettled
                )
                  settled = false;
                throw error;
              }
            },
          },
          directory,
        );
      } finally {
        // Never remove the working index of a potentially live Git child.
        if (settled) {
          await assertDirectory();
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    },
    async inTemporaryRepository<T>(
      action: (client: NativeGitClient, root: string) => Promise<T>,
    ): Promise<T> {
      // Separate gitdir is mandatory: merge backends may write AUTO_MERGE even
      // with an alternate index/worktree. Nothing here publishes into the source.
      const scratch = await fs.mkdtemp(
        path.join(await fs.realpath(os.tmpdir()), "goga-native-witness-"),
      );
      let settled = true;
      try {
        const isolated = await createNativeGitClient({
          ...options,
          root: scratch,
          configuration: [
            ...config.map(
              ([key, value]) =>
                [
                  key,
                  key.toLowerCase() === "core.attributesfile" &&
                  value &&
                  !path.isAbsolute(value) &&
                  !value.startsWith("~")
                    ? path.resolve(root, value)
                    : value,
                ] as const,
            ),
            ["core.worktree", scratch],
            ["core.bare", "false"],
          ],
          runner: {
            commandBytes: async (request) => {
              try {
                const result = await command(request);
                if (!result.processSettled) settled = false;
                return result;
              } catch (error) {
                if (
                  !(error instanceof ByteCommandError) ||
                  !error.processSettled
                )
                  settled = false;
                throw error;
              }
            },
          },
        });
        const format = await this.run({
          policy: "local-read",
          command: "rev-parse",
          args: ["--show-object-format"],
        });
        requireSettled(format);
        const objectFormat = format.stdout.toString("utf8").trim();
        if (format.exitCode !== 0 || !["sha1", "sha256"].includes(objectFormat))
          throw Error(
            "Не удалось определить формат объектов Git для проверки.",
          );
        const initialized = await isolated.run({
          policy: "local-write",
          command: "init",
          args: [
            "--template=",
            "--initial-branch=witness",
            `--object-format=${objectFormat}`,
          ],
        });
        requireSettled(initialized);
        if (initialized.exitCode !== 0)
          throw Error("Не удалось подготовить изолированную проверку Git.");
        const objects = path.join(root, ".git", "objects");
        await noSymlinks(objects);
        // Git's documented alternates file uses C-quoted paths. Octal encoding
        // also handles newline/non-ASCII source paths without injecting entries.
        const quoted =
          '"' +
          [...Buffer.from(objects)]
            .map((byte) =>
              byte >= 32 && byte <= 126 && byte !== 34 && byte !== 92
                ? String.fromCharCode(byte)
                : "\\" + byte.toString(8).padStart(3, "0"),
            )
            .join("") +
          '"\n';
        await fs.writeFile(
          path.join(scratch, ".git/objects/info/alternates"),
          quoted,
          { flag: "wx", mode: 0o600 },
        );
        const attributes = path.join(root, ".git/info/attributes");
        try {
          await noSymlinks(attributes);
          const stat = await fs.lstat(attributes);
          if (!stat.isFile() || stat.size > 1024 * 1024)
            throw Error("Недопустимые атрибуты Git.");
          await fs.copyFile(
            attributes,
            path.join(scratch, ".git/info/attributes"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return await action(isolated, scratch);
      } finally {
        // A potentially live child must not lose its working directory.
        if (settled) await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    async run(request: NativeGitRequest): Promise<ByteCommandResult> {
      const args = nativeGitArguments(request, config),
        started = performance.now();
      const stdin = request.stdin && Buffer.from(request.stdin);
      try {
        const result = await withNativeGitPolicy(request.policy, () =>
          command({
            executable,
            cwd: root,
            env,
            args,
            stdin,
            ...("verifyPrepared" in request && request.verifyPrepared
              ? { verifyPrepared: request.verifyPrepared }
              : {}),
          }),
        );
        report(request, started, result);
        return result;
      } catch (error) {
        report(request, started, undefined, error);
        throw error;
      }
    },
  });
}

export function gitLiteralPaths(paths: readonly string[]): Buffer {
  if (
    !paths.length ||
    paths.some(
      (name) =>
        !name ||
        name.includes("\0") ||
        Buffer.from(name, "utf8").toString("utf8") !== name ||
        path.posix.isAbsolute(name) ||
        name.split("/").some((part) => !part || part === "." || part === ".."),
    )
  )
    throw Error("Недопустимый путь файла Git.");
  return Buffer.from(paths.join("\0") + "\0", "utf8");
}
