import { t as tr } from "../shared/i18n";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { ByteCommandError, type Runner } from "./process";
import { withReadScope } from "./read-scope";
import type { Project } from "../shared/types";
import {
  projectCreationRequestSchema,
  type ProjectCreationRequest,
  type ProjectCreationProgress,
  type ProjectCreationResult,
} from "../shared/project-creation";
import type { PreparedShutdown } from "./shutdown";

type Attempt = {
  id: string;
  controller: AbortController;
  canCancel: boolean;
  promise: Promise<ProjectCreationResult>;
};
const sameDirectory = (a: Stats, b: Stats) =>
  b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
class CreationFailure extends Error {
  constructor(
    message: string,
    readonly field?: "name" | "parent" | "repository",
  ) {
    super(message);
  }
}
async function absent(file: string) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
/** Owns only a newly reserved directory and its child process, never a project lock.
 * Preparation is private; registration happens only after a completed publication.
 */
export class ProjectCreationCoordinator {
  private active?: Attempt;
  private results = new Map<
    string,
    { request: string; promise: Promise<ProjectCreationResult> }
  >();
  private frozen = false;
  private disposed = false;
  private unsettled?: string;
  constructor(
    private options: {
      runner: Runner;
      home: string;
      register: (folder: string) => Promise<Project>;
      progress: (value: ProjectCreationProgress) => void;
    },
  ) {}
  create(input: ProjectCreationRequest): Promise<ProjectCreationResult> {
    const parsed = projectCreationRequestSchema.safeParse(input);
    const failure = (message: string) =>
      Promise.resolve<ProjectCreationResult>({ status: "error", message });
    if (!parsed.success)
      return failure(tr("host.checkTheNameLocationAndRepositoryAddress"));
    const request = parsed.data,
      signature = JSON.stringify(request),
      prior = this.results.get(request.id);
    if (prior)
      return prior.request === signature
        ? prior.promise
        : failure(tr("host.thisAttemptIdHasAlreadyBeenUsed"));
    if (this.disposed || this.frozen)
      return failure(tr("host.theAppIsPreparingToExitProjectCreationIsUnavailable"));
    if (this.unsettled)
      return failure(
        tr("host.thePreviousGitProcessHasNotBeenConfirmedStoppedRetry"),
      );
    if (this.active)
      return failure(
        tr("host.anotherProjectIsBeingCreatedWaitForItToFinish"),
      );
    const attempt: Attempt = {
      id: request.id,
      controller: new AbortController(),
      canCancel: true,
      promise: Promise.resolve({ status: "cancelled" }),
    };
    this.active = attempt;
    attempt.promise = Promise.resolve()
      .then(() => this.execute(request, attempt))
      .finally(() => {
        if (this.active === attempt) this.active = undefined;
      });
    this.results.set(request.id, {
      request: signature,
      promise: attempt.promise,
    });
    if (this.results.size > 64)
      this.results.delete(this.results.keys().next().value!);
    return attempt.promise;
  }
  cancel(id: string) {
    const attempt = this.active;
    if (!attempt || attempt.id !== id || !attempt.canCancel) return false;
    attempt.controller.abort();
    this.progress(attempt, "cancelling");
    return true;
  }
  async cancelAndWait(id: string): Promise<ProjectCreationResult> {
    this.cancel(id);
    // Also returns a completed result if the original IPC response was lost.
    // An unknown ID never starts anything and has no filesystem authority.
    return this.results.get(id)?.promise ?? { status: "cancelled" };
  }
  private progress(attempt: Attempt, stage: ProjectCreationProgress["stage"]) {
    // Progress delivery must not turn a completed filesystem operation into a failure.
    try {
      this.options.progress({
        id: attempt.id,
        stage,
        canCancel: attempt.canCancel && !attempt.controller.signal.aborted,
      });
    } catch {
      /* Observer only. */
    }
  }
  private async git(args: string[], cwd: string, attempt: Attempt) {
    if (!this.options.runner.commandBytes)
      throw new CreationFailure(tr("host.gitCannotBeStartedSafely"));
    const env: NodeJS.ProcessEnv = {
      HOME: this.options.home,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS_REQUIRE: "never",
      GIT_ALLOW_PROTOCOL: "https:ssh",
      GIT_CONFIG: undefined,
      GIT_TEMPLATE_DIR: undefined,
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_TRACE")) env[key] = undefined;
    Object.assign(env, {
      GIT_TRACE2: "0",
      GIT_TRACE2_EVENT: "0",
      GIT_TRACE2_PERF: "0",
    });
    const result = await withReadScope(attempt.controller.signal, () =>
      this.options.runner.commandBytes!({
        executable: "git",
        cwd,
        env,
        args: [
          "--no-pager",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          "-c",
          "submodule.recurse=false",
          "-c",
          "credential.interactive=false",
          ...args,
        ],
      }),
    );
    if (result.exitCode !== 0 || result.signal)
      throw new CreationFailure(
        args[0] === "clone"
          ? tr("host.gitCloneFailedCodeValue1CheckTheAddressAndGit", { value1: result.exitCode ?? "—" })
          : tr("host.gitInitFailedCodeValue1CheckGitAndFolderPermissions", { value1: result.exitCode ?? "—" }),
      );
  }
  private async execute(
    request: ProjectCreationRequest,
    attempt: Attempt,
  ): Promise<ProjectCreationResult> {
    let staging: string | undefined,
      stagingIdentity: Stats | undefined,
      destination: string | undefined;
    let reservation: Stats | undefined,
      published = false;
    const check = () => {
      if (attempt.controller.signal.aborted)
        throw new CreationFailure(tr("host.creationCanceled"));
    };
    const cleanup = async (): Promise<string | undefined> => {
      if (reservation && destination && !published) {
        try {
          if (sameDirectory(reservation, await lstat(destination)))
            await rmdir(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return destination;
        }
      }
      if (staging && stagingIdentity) {
        try {
          if (!sameDirectory(stagingIdentity, await lstat(staging)))
            return staging;
          await rm(staging, { recursive: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            return staging;
        }
      }
    };
    try {
      this.progress(attempt, "checking");
      check();
      const parent = await realpath(request.parent),
        parentIdentity = await lstat(parent);
      if (!parentIdentity.isDirectory())
        throw new CreationFailure(tr("host.chooseAnExistingParentFolder"));
      destination = path.join(parent, request.name);
      if (!(await absent(destination)))
        throw new CreationFailure(
          tr("host.aFileOrFolderWithThisNameAlreadyExistsChoose"),
          "name",
        );
      check();
      staging = await mkdtemp(path.join(parent, ".goga-create-"));
      stagingIdentity = await lstat(staging);
      const prepared = path.join(staging, "project");
      check();
      if (request.mode === "clone") {
        this.progress(attempt, "cloning");
        await this.git(
          [
            "clone",
            "--template=",
            "--no-recurse-submodules",
            "--",
            request.repository,
            prepared,
          ],
          staging,
          attempt,
        );
      } else {
        this.progress(attempt, "creating");
        await mkdir(prepared);
        if (request.git) {
          check();
          this.progress(attempt, "git");
          await this.git(
            ["init", "--template=", "-b", "main"],
            prepared,
            attempt,
          );
        }
      }
      check();
      if (
        !(await lstat(prepared)).isDirectory() ||
        (await realpath(prepared)) !== prepared
      )
        throw new CreationFailure(tr("host.gitDidNotCreateTheExpectedProjectFolder"));
      if (request.mode === "clone" || request.git) {
        const metadata = await lstat(path.join(prepared, ".git"));
        if (!metadata.isDirectory() || metadata.isSymbolicLink())
          throw new CreationFailure(
            tr("host.gitDidNotCreateAnIndependentRepository"),
          );
      }
      if (
        !sameDirectory(parentIdentity, await lstat(parent)) ||
        (await realpath(request.parent)) !== parent
      )
        throw new CreationFailure(
          tr("host.theLocationChangedDuringCreationChooseTheFolderAgain"),
        );
      check();
      // From this point finish publication/registration rather than cancelling a ready project.
      attempt.canCancel = false;
      this.progress(attempt, "registering");
      await mkdir(destination);
      reservation = await lstat(destination);
      if (
        !sameDirectory(reservation, await lstat(destination)) ||
        (await readdir(destination)).length
      )
        throw new CreationFailure(
          tr("host.anotherProcessChangedTheDestinationFolderTheProjectWasNot"),
        );
      await rename(prepared, destination);
      published = true;
      let project: Project;
      try {
        project = await this.options.register(destination);
      } catch {
        throw new CreationFailure(
          tr("host.theProjectWasCreatedButNotAddedToTheList"),
        );
      }
      const retainedPath = await cleanup();
      // Registration is the outcome; cleanup is a separate visible warning. Do
      // not turn a ready project into a retry against its now-occupied directory.
      return {
        status: "success",
        project,
        ...(retainedPath
          ? {
              warning: tr("host.projectCreatedCouldNotRemoveTheTemporaryFolderRetainedpath", { retainedPath: retainedPath }),
            }
          : {}),
      };
    } catch (error) {
      const unsettled =
        error instanceof ByteCommandError && !error.processSettled;
      if (unsettled) this.unsettled = attempt.id;
      const retainedPath = unsettled ? staging : await cleanup();
      if (attempt.controller.signal.aborted && !unsettled && !published)
        return {
          status: "cancelled",
          ...(retainedPath ? { retainedPath } : {}),
        };
      let message: string;
      if (unsettled)
        message =
          tr("host.theGitProcessWasNotConfirmedStoppedTheTemporaryFolder");
      else if (error instanceof CreationFailure) message = error.message;
      else if (error instanceof ByteCommandError)
        message =
          error.reason === "timeout"
            ? tr("host.gitDidNotFinishWithin30MinutesAndWasStopped")
            : tr("host.couldNotRunGitCheckInstallationAndRepositoryAccessThen");
      else if ((error as NodeJS.ErrnoException).code === "EEXIST")
        message =
          tr("host.aFolderWithThisNameAlreadyExistsChooseAnotherName");
      else
        message =
          tr("host.couldNotCreateTheProjectCheckTheLocationFreeSpace");
      return {
        status: "error",
        message,
        ...(error instanceof CreationFailure && error.field
          ? { field: error.field }
          : (error as NodeJS.ErrnoException).code === "EEXIST"
            ? { field: "name" as const }
            : {}),
        ...((published ? destination : retainedPath)
          ? { retainedPath: published ? destination : retainedPath }
          : {}),
      };
    }
  }
  async prepareShutdown(): Promise<PreparedShutdown> {
    // Disposal seals new creations, not future exit attempts. A later shutdown
    // participant may fail after this one has already completed; its next lease
    // must report the remaining work (including unsettled cleanup), not deadlock.
    if (this.frozen)
      throw Error(tr("host.exitPreparationIsAlreadyInProgress"));
    this.frozen = true;
    const id = this.active?.id ?? this.unsettled;
    let released = false;
    const validate = () => {
      if (released || (this.active && this.active.id !== id))
        throw Error(tr("host.theSetOfActiveOperationsChanged"));
    };
    const stop = async () => {
      validate();
      if (this.active) {
        this.cancel(this.active.id);
        await this.active.promise;
      }
      if (this.unsettled) {
        await this.options.runner.dispose?.();
        this.unsettled = undefined;
        this.disposed = true;
      }
    };
    return {
      items: id
        ? [
            {
              id: `project-create:${id}`,
              label: tr("host.newProjectCreationWillBeCanceledOnExit"),
            },
          ]
        : [],
      requiresConfirmation: !!id,
      validate,
      stop,
      keep: stop,
      validateKeep: async () => validate(),
      retained: () => [],
      remaining: () =>
        (this.active?.id ?? this.unsettled)
          ? [`project-create:${this.active?.id ?? this.unsettled}`]
          : [],
      release: () => {
        released = true;
        this.frozen = false;
      },
    };
  }
  async dispose() {
    this.disposed = true;
    if (this.active) {
      this.cancel(this.active.id);
      await this.active.promise;
    }
    await this.options.runner.dispose?.();
    this.unsettled = undefined;
  }
}
