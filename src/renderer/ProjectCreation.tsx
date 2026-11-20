import type { MessageKey } from "../shared/locale-packs.generated";
import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  LoaderCircle,
  MapPin,
  RotateCcw,
} from "lucide-react";
import type { Project } from "../shared/types";
import {
  projectCreationRequestSchema,
  repositoryFolderName,
  type ProjectCreationProgress,
  type ProjectCreationStage,
  type ProjectCreationResult,
} from "../shared/project-creation";
import { TopicModal } from "./TopicsCommon";
import { preparationErrorMessage } from "./preparation-error";
import "./ProjectCreation.css";

type Mode = "empty" | "clone";
interface Draft {
  name: string;
  parent: string;
  repository: string;
  git: boolean;
  nameEdited: boolean;
}
const empty = (): Draft => ({
  name: "",
  parent: "",
  repository: "",
  git: true,
  nameEdited: false,
});
const destination = (draft: Draft) =>
  draft.parent
    ? `${draft.parent.replace(/\/+$/, "")}/${draft.name || msg("shell.projectName")}`
    : msg("shell.chooseProjectLocation");
const labels = {
  checking: "shell.checkingLocation",
  creating: "shell.creatingProjectFolder",
  git: "shell.initializingGit",
  cloning: "shell.fetchingRepositoryFiles",
  registering: "shell.addingProjectToGoga",
  cancelling: "shell.stoppingProjectCreation",
} as const satisfies Record<ProjectCreationStage, MessageKey>;
export function ProjectCreationDialog({
  onClose,
  onSuccess,
  onOpenExisting,
}: {
  onClose: () => void;
  onSuccess: (project: Project, warning?: string) => void;
  onOpenExisting: () => void;
}) {
  useLocale();
  const [mode, setMode] = useState<Mode>("empty");
  const [drafts, setDrafts] = useState<Record<Mode, Draft>>({
    empty: empty(),
    clone: empty(),
  });
  const value = drafts[mode];
  const [operation, setOperation] = useState<ProjectCreationProgress | null>(
    null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState(""),
    [notice, setNotice] = useState(""),
    [retained, setRetained] = useState("");
  const [choosing, setChoosing] = useState(false);
  const active = useRef<string | null>(null),
    alive = useRef(true),
    form = useRef<HTMLFormElement>(null);
  const complete = useRef(onSuccess);
  complete.current = onSuccess;
  const busy = !!operation;
  const stages: ProjectCreationStage[] =
    mode === "clone"
      ? ["checking", "cloning", "registering"]
      : value.git
        ? ["checking", "creating", "git", "registering"]
        : ["checking", "creating", "registering"];
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.goga.onProjectCreation((progress) => {
      if (active.current === progress.id) setOperation(progress);
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    form.current
      ?.querySelector<HTMLInputElement>(
        mode === "clone" ? "#repository" : "#project-name",
      )
      ?.focus();
  }, [mode]);
  useEffect(() => {
    const input = form.current?.querySelector<HTMLInputElement>(
      '[aria-invalid="true"]',
    );
    input?.focus();
    input?.closest(".creation-field")?.scrollIntoView({ block: "nearest" });
  }, [errors]);
  useEffect(() => {
    if (message || notice)
      form.current
        ?.querySelector(".creation-error,.creation-notice")
        ?.scrollIntoView({ block: "nearest" });
  }, [message, notice]);
  function edit(
    field: "name" | "parent" | "repository" | "git",
    next: string | boolean,
  ) {
    if (active.current) return;
    setDrafts((current) => {
      const updated = { ...current[mode], [field]: next };
      if (field === "name") updated.nameEdited = true;
      if (field === "repository" && !updated.nameEdited)
        updated.name = repositoryFolderName(String(next));
      return { ...current, [mode]: updated };
    });
    setErrors({});
    setMessage("");
    setNotice("");
    setRetained("");
  }
  function switchMode(next: Mode) {
    if (active.current || choosing) return;
    setMode(next);
    setErrors({});
    setMessage("");
    setNotice("");
    setRetained("");
  }
  async function choose() {
    if (choosing || active.current) return;
    setChoosing(true);
    try {
      const parent = await window.goga.chooseProjectLocation();
      if (alive.current && parent) {
        edit("parent", parent);
      }
    } catch (error) {
      if (alive.current) setMessage(preparationErrorMessage(error));
    } finally {
      if (alive.current) setChoosing(false);
    }
  }
  async function submit() {
    if (active.current || choosing) return;
    const id = crypto.randomUUID();
    const parsed = projectCreationRequestSchema.safeParse({
      id,
      mode,
      parent: value.parent,
      name: value.name,
      ...(mode === "empty"
        ? { git: value.git }
        : { repository: value.repository.trim() }),
    });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [
            String(issue.path[0]),
            issue.path[0] === "name"
              ? msg("shell.enterAFolderNameWithoutPathSeparatorsOrLeadingOr")
              : issue.path[0] === "parent"
                ? msg("shell.chooseAParentFolderOrEnterAnAbsolutePath")
                : msg("shell.enterAnHTTPSOrSSHURLWithoutAPasswordToken"),
          ]),
        ),
      );
      return;
    }
    active.current = id;
    setErrors({});
    setMessage("");
    setNotice("");
    setRetained("");
    setOperation({ id, stage: "checking", canCancel: true });
    try {
      const result = await window.goga.createProject(parsed.data);
      finish(id, result);
    } catch (error) {
      if (!alive.current || active.current !== id) return;
      // Transport failure is not evidence of cancellation. The host still owns
      // the attempt; keep cancel available instead of silently starting a second.
      setMessage(
        msg("shell.projectCreationIsUnconfirmedCancelTheOperationOrCheckIts", { value1: String(preparationErrorMessage(error)) }),
      );
    }
  }
  function finish(id: string, result: ProjectCreationResult) {
    if (!alive.current || active.current !== id) return;
    active.current = null;
    setOperation(null);
    setMessage("");
    if (result.status === "success") {
      if (result.warning) complete.current(result.project, result.warning);
      else complete.current(result.project);
    } else {
      setRetained(result.retainedPath ?? "");
      if (result.status === "error") {
        if (result.field) setErrors({ [result.field]: result.message });
        else setMessage(result.message);
      } else
        setNotice(
          result.retainedPath
            ? msg("shell.creationWasCanceledTheTemporaryFolderCouldNotBeRemoved")
            : msg("shell.creationWasCanceledYourEntriesHaveBeenKept"),
        );
    }
  }
  async function cancel() {
    const id = active.current;
    if (!id || (!operation?.canCancel && !message)) return;
    setOperation((current) =>
      current
        ? {
            ...current,
            stage: current.canCancel ? "cancelling" : current.stage,
            canCancel: false,
          }
        : current,
    );
    try {
      finish(id, await window.goga.cancelProjectCreation(id));
    } catch (error) {
      if (alive.current && active.current === id) {
        setMessage(preparationErrorMessage(error));
        setOperation((current) =>
          current ? { ...current, canCancel: true } : current,
        );
      }
    }
  }
  return (
    <TopicModal
      title={
        busy
          ? mode === "clone"
            ? msg("shell.cloningRepository")
            : msg("shell.creatingProject")
          : msg("shell.newProject")
      }
      className="project-creation-dialog"
      closeLabel={msg("shell.closeProjectCreation")}
      busy={busy || choosing}
      onClose={onClose}
    >
      <form
        ref={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="creation-body">
          {busy ? (
            <section
              className="creation-progress"
              aria-label={msg("shell.projectCreationProgress")}
              aria-busy="true"
            >
              <div className="creation-progress-target">
                <span className="creation-progress-icon">
                  <FolderPlus size={26} aria-hidden="true" />
                </span>
                <div>
                  <h3>{value.name}</h3>
                  <code>{destination(value)}</code>
                </div>
              </div>
              <ol className="creation-steps">
                {stages.map((stage, index) => {
                  const current = stages.indexOf(operation.stage),
                    done = current > index;
                  return (
                    <li
                      key={stage}
                      className={
                        done ? "done" : current === index ? "current" : ""
                      }
                    >
                      {done ? (
                        <Check size={18} aria-hidden="true" />
                      ) : current === index ? (
                        <LoaderCircle
                          className="creation-spinning"
                          size={18}
                          aria-hidden="true"
                        />
                      ) : (
                        <span className="creation-step-dot" />
                      )}
                      <span>{msg(labels[stage])}</span>
                    </li>
                  );
                })}
              </ol>
              <p className="creation-progress-note" role="status">
                {msg(labels[operation.stage])}…
              </p>
              <p className="creation-muted">{msg("shell.overviewWillOpenForTheNewProjectWhenItIs")}</p>
            </section>
          ) : (
            <>
              <div
                className="creation-modes"
                role="tablist"
                aria-label={msg("shell.howToCreateTheProject")}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                    return;
                  event.preventDefault();
                  switchMode(mode === "clone" ? "empty" : "clone");
                }}
              >
                <button
                  type="button"
                  id="empty-mode"
                  role="tab"
                  aria-selected={mode === "empty"}
                  aria-controls="creation-fields"
                  tabIndex={mode === "empty" ? 0 : -1}
                  disabled={choosing}
                  onClick={() => switchMode("empty")}
                >
                  <FolderPlus size={19} aria-hidden="true" />
                  <span>{msg("shell.fromScratch")}<small>{msg("shell.newEmptyFolder")}</small>
                  </span>
                </button>
                <button
                  type="button"
                  id="clone-mode"
                  role="tab"
                  aria-selected={mode === "clone"}
                  aria-controls="creation-fields"
                  tabIndex={mode === "clone" ? 0 : -1}
                  disabled={choosing}
                  onClick={() => switchMode("clone")}
                >
                  <GitFork size={19} aria-hidden="true" />
                  <span>{msg("shell.fromAGitRepository")}<small>{msg("shell.aCopyOnThisComputer")}</small>
                  </span>
                </button>
              </div>
              <div
                id="creation-fields"
                role="tabpanel"
                aria-labelledby={mode === "empty" ? "empty-mode" : "clone-mode"}
                className="creation-fields"
              >
                {mode === "clone" && (
                  <div className="creation-field">
                    <label htmlFor="repository">{msg("shell.repositoryURL")}</label>
                    <input
                      id="repository"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="https://example.com/team/project.git"
                      value={value.repository}
                      aria-invalid={!!errors.repository}
                      aria-describedby={
                        errors.repository
                          ? "repository-error"
                          : "repository-hint"
                      }
                      onChange={(event) =>
                        edit("repository", event.target.value)
                      }
                    />
                    {errors.repository ? (
                      <p
                        id="repository-error"
                        role="alert"
                        className="creation-field-error"
                      >
                        {errors.repository}
                      </p>
                    ) : (
                      <small id="repository-hint">{msg("shell.httpsOrSSHYourExistingGitCredentialsAreUsedNo")}</small>
                    )}
                  </div>
                )}
                <div className="creation-field">
                  <label htmlFor="project-name">{msg("shell.projectFolderName")}</label>
                  <input
                    id="project-name"
                    placeholder="my-project"
                    autoComplete="off"
                    spellCheck={false}
                    value={value.name}
                    aria-invalid={!!errors.name}
                    aria-describedby={errors.name ? "name-error" : undefined}
                    onChange={(event) => edit("name", event.target.value)}
                  />
                  {errors.name && (
                    <p
                      id="name-error"
                      role="alert"
                      className="creation-field-error"
                    >
                      {errors.name}
                      <button
                        className="creation-inline-link"
                        type="button"
                        onClick={onOpenExisting}
                      >{msg("shell.openExistingProject")}</button>
                    </p>
                  )}
                </div>
                <div className="creation-field">
                  <label htmlFor="project-parent">{msg("shell.location")}</label>
                  <div className="creation-location">
                    <input
                      id="project-parent"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={msg("shell.chooseTheParentFolder")}
                      value={value.parent}
                      aria-invalid={!!errors.parent}
                      aria-describedby={
                        errors.parent ? "parent-error" : "destination-preview"
                      }
                      onChange={(event) => edit("parent", event.target.value)}
                    />
                    <button
                      type="button"
                      className="with-icon"
                      disabled={choosing}
                      onClick={() => void choose()}
                      aria-label={msg("shell.chooseProjectLocation2")}
                    >
                      <FolderOpen size={17} aria-hidden="true" />
                      <span>{msg("shell.choose")}</span>
                    </button>
                  </div>
                  {errors.parent && (
                    <p
                      id="parent-error"
                      className="creation-field-error"
                      role="alert"
                    >
                      {errors.parent}
                    </p>
                  )}
                  <div
                    className="creation-destination"
                    id="destination-preview"
                  >
                    <MapPin size={15} aria-hidden="true" />
                    <div>
                      <span>{msg("shell.aNewFolderWillBeCreated")}</span>
                      <code>{destination(value)}</code>
                    </div>
                  </div>
                </div>
                {mode === "empty" ? (
                  <label className="creation-git-option">
                    <input
                      type="checkbox"
                      checked={value.git}
                      onChange={(event) => edit("git", event.target.checked)}
                    />
                    <span>
                      <strong>{msg("shell.initializeGit")}</strong>
                      <small>{msg("shell.localRepositoryWithoutCommittingOrPublishing")}</small>
                    </span>
                    <GitBranch size={18} aria-hidden="true" />
                  </label>
                ) : (
                  <p className="creation-clone-note">
                    <GitBranch size={16} aria-hidden="true" />
                    <span>{msg("shell.theRepositorySDefaultBranchWillOpenNothingWillBe")}</span>
                  </p>
                )}
              </div>
              {notice && (
                <p role="status" className="creation-notice">
                  {notice}
                </p>
              )}
            </>
          )}
          {message && (
            <div role="alert" className="creation-error">
              <AlertCircle size={18} aria-hidden="true" />
              <div>
                <strong>{msg("shell.creationIncomplete")}</strong>
                <p>{message}</p>
                {!busy && (
                  <button
                    className="creation-inline-link"
                    type="button"
                    onClick={onOpenExisting}
                  >{msg("shell.openExistingProject")}</button>
                )}
              </div>
            </div>
          )}
          {retained && (
            <p className="creation-retained">
              <span>{msg("shell.savedFolder")}</span>
              <code>{retained}</code>
            </p>
          )}
        </div>
        <footer className="creation-footer">
          <span className="creation-muted">
            {busy
              ? operation.canCancel
                ? msg("shell.youCanCancelThisOperation")
                : msg("shell.pleaseWaitForTheOperationToFinish")
              : msg("shell.theProjectWillOpenInOverview")}
          </span>
          <div className="creation-actions">
            {busy ? (
              <button
                type="button"
                disabled={!operation.canCancel && !message}
                onClick={() => void cancel()}
              >
                {!operation.canCancel && message
                  ? msg("shell.checkResult")
                  : msg("shell.cancelCreation")}
              </button>
            ) : (
              <>
                <button type="button" disabled={choosing} onClick={onClose}>{msg("shell.cancel")}</button>
                <button
                  type="submit"
                  disabled={choosing}
                  className="primary with-icon"
                >
                  {message ? (
                    <>
                      <RotateCcw size={16} aria-hidden="true" />{msg("shell.retry")}</>
                  ) : mode === "clone" ? (
                    msg("shell.cloneAndOpen")
                  ) : (
                    msg("shell.createProject")
                  )}
                </button>
              </>
            )}
          </div>
        </footer>
      </form>
    </TopicModal>
  );
}
