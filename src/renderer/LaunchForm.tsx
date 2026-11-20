import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { pipelineDisplayMetadata } from "../shared/pipeline-display";
import { preparationErrorMessage } from "./preparation-error";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey, draftKey } from "./topic-context";
import { readRequest, useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useRef, useState, useId } from "react";
import type {
  Project,
  Discovery,
  Preview,
  Run,
  LaunchRequest,
} from "../shared/types";
import "../shared/bridge";
import type { TopicTarget } from "../shared/topics";
import { TopicSelect } from "./TopicSelect";
import {
  createDraftStore,
  useTaskDraft,
  type DraftStore,
  type TaskDraft,
} from "./task-drafts";
import { SearchablePicker } from "./SearchablePicker";
import "./LaunchForm.css";
import { SplitLaunchButton } from "./SplitLaunchButton";
import { BranchLaunchConfirmation } from "./BranchLaunchConfirmation";
import { TaskReloadConfirmation } from "./TaskReloadConfirmation";
const missingProfileName = (data: Discovery, profile: string) => {
  const selected =
    profile === "__auto__"
      ? ""
      : profile || data.projectSettings?.profile || "";
  return selected && !data.profiles.some((item) => item.name === selected)
    ? selected
    : "";
};
const message = preparationErrorMessage;

export function LaunchForm({
  project,
  owner,
  blocked = false,
  onLaunched,
  onTopicsChanged,
  onCancel,
  draftStore,
  settingsRevision,
  suspended = false,
  preparedTopic,
  onOpenTopic,
  onPrepared,
  onBusyChange,
  onLaunchStarted,
}: {
  project: Project;
  owner?: TopicContextRef;
  blocked?: boolean | string;
  onLaunched: (run: Run, stale?: boolean) => void | Promise<void>;
  onTopicsChanged?: () => void;
  onCancel: () => void;
  onBusyChange?: (projectId: string, busy: boolean) => void;
  onLaunchStarted?: () => void;
  draftStore?: DraftStore;
  settingsRevision?: string;
  suspended?: boolean;
  preparedTopic?: { target: TopicTarget; text?: string; nonce: number };
  onPrepared?: (nonce: number) => void;
  onOpenTopic?: (
    target: TopicTarget,
    text: string,
    isNew: boolean,
    edit: (text: string) => void,
  ) => void;
}) {
  useLocale();
  const scope = owner ? contextRef(owner) : project.id;
  const ownerKey = owner ? contextRequestKey(owner) : project.id;
  const storageKey = owner ? draftKey(owner, "pipeline") : project.id;
  const mounted = useRef(false);
  const read = useReadScope(ownerKey);
  const topicModeName = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const localDrafts = useRef(createDraftStore());
  const drafts = draftStore ?? localDrafts.current;
  const initial = drafts.forms.get(storageKey);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const catalogKey = JSON.stringify([ownerKey, catalogAttempt]);
  const [catalogSettled, setCatalogSettled] = useState("");
  const [catalogData, setData] = useState<Discovery | null>(null),
    [error, setError] = useState(""),
    [pipeline, setPipeline] = useState("");
  // A changed owner/revision must not start its initial reads with the catalog
  // still in state from the preceding render.
  const data = catalogSettled === catalogKey ? catalogData : null;
  // Only the first projection of an accepted catalog can share its host work.
  // Subsequent edits, retries, and explicit rereads keep the ordinary requests.
  const [consumedFormReadId, setConsumedFormReadId] = useState<string>();
  const catalogReadId = data?.formReadId;
  const formReadId =
    !suspended && catalogReadId !== consumedFormReadId
      ? catalogReadId
      : undefined;
  useEffect(() => {
    if (catalogReadId) setConsumedFormReadId(catalogReadId);
  }, [catalogReadId]);
  // Catalog/preview refreshes must not erase a failed submitted operation.
  const [launchError, setLaunchError] = useState("");
  const [workflow, setWorkflow] = useState("auto"),
    [profile, setProfile] = useState(initial?.profile ?? ""),
    [skips, setSkips] = useState<string[]>([]);
  const [topicMode, setMode] = useState<"none" | "existing" | "new">(
      owner ? "existing" : (initial?.mode ?? "none"),
    ),
    [topicIndex, setTopicIndex] = useState("0"),
    [name, setName] = useState(initial?.name ?? ""),
    [baseRef, setBaseRef] = useState(initial?.baseRef ?? "HEAD");
  // Missing Git changes the available destination, not the stored topic draft.
  const repositoryMissing = !owner && data?.repository === "missing";
  const mode = repositoryMissing ? "none" : topicMode;
  const [confirmEmpty, setConfirmEmpty] = useState(false),
    [clean, setClean] = useState(false),
    [launching, setLaunching] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [cards, setCards] = useState<Preview["stages"]>([]),
    [pending, setPending] = useState(true),
    [resetNote, setResetNote] = useState("");
  // Only presentation differs: every change still needs a fresh exact preview.
  // Pipeline changes load the stage area; checkbox changes keep it interactive.
  const [previewRefresh, setPreviewRefresh] = useState<
    "pipeline" | "stages" | null
  >(null);
  // Destructive consent belongs to this target and this attempt only.
  useEffect(
    () => setClean(false),
    [project.id, pipeline, mode, topicIndex, name, baseRef],
  );
  const [settingsRefreshing, setSettingsRefreshing] = useState(false);
  const [settingsRefreshAttempt, setSettingsRefreshAttempt] = useState(0);
  // Even an instantly refreshed catalog re-arms the exact selection check.
  // A full preview is already exact when no stages were skipped.
  const [appliedCatalogEpoch, setAppliedCatalogEpoch] = useState(0);
  const [settingsRefreshError, setSettingsRefreshError] = useState("");
  const [settingsPreviewFailure, setSettingsPreviewFailure] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewSettled, setPreviewSettled] = useState("");
  const [previewError, setPreviewError] = useState("");
  const initialSettingsRevision = useRef(settingsRevision);
  // A hidden form retains its draft, not permission to do discovery work.
  // Lifetime is separate from explicit task reload/reset and branch observation.
  const discoveryKey = JSON.stringify([
    catalogKey, settingsRevision, settingsRefreshAttempt,
  ]);
  const readCatalog = useReadScope(JSON.stringify([discoveryKey, suspended]));
  const failedRefreshKey = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const launchInFlight = useRef(false);
  const discoveryInFlight = useRef(true);
  // Catalog requests have their own epoch: previews must not invalidate them.
  const discoveryGeneration = useRef(0);
  const currentBranchRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      suspended || catalogSettled === catalogKey ||
      settingsRevision !== initialSettingsRevision.current
    ) return;
    let alive = true;
    const epoch = ++discoveryGeneration.current;
    discoveryInFlight.current = true;
    setData(null);
    setPreviewRefresh(null);
    setPending(true);
    currentBranchRef.current = null;
    setError("");
    readCatalog("discover", scope, { forLaunchForm: true }).then(
      (d) => {
        if (!alive || epoch !== discoveryGeneration.current) return;
        discoveryInFlight.current = false;
        setCatalogSettled(catalogKey);
        currentBranchRef.current = d.currentBranch;
        setData(d);
        setPipeline(d.pipelines[0]?.id ?? "");
        setTopicIndex(
          String(
            Math.max(
              0,
              d.topics.findIndex(
                (t) =>
                  t.branch ===
                    (drafts.forms.get(storageKey)?.branch || d.currentBranch) &&
                  (!drafts.forms.get(storageKey)?.topic ||
                    t.topic === drafts.forms.get(storageKey)?.topic),
              ),
            ),
          ),
        );
        if (!d.pipelines.length) {
          setPending(false);
        }
      },
      (e) => {
        if (alive && epoch === discoveryGeneration.current) {
          discoveryInFlight.current = false;
          setCatalogSettled(catalogKey);
          setPending(false);
          setError(message(e));
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [catalogKey, settingsRevision, suspended]);
  useEffect(() => {
    if (
      suspended || settingsRevision === initialSettingsRevision.current ||
      failedRefreshKey.current === discoveryKey
    ) return;
    let alive = true;
    const epoch = ++discoveryGeneration.current;
    discoveryInFlight.current = true;
    generation.current++;
    setPreviewRefresh(null);
    setPending(true);
    setPreview(null);
    setReadyKey("");
    setClean(false);
    setSettingsRefreshing(true);
    setSettingsRefreshError("");
    setSettingsPreviewFailure(false);
    const selectedTopic = data?.topics[Number(topicIndex)];
    (async () => {
      let readingPreview = false;
      try {
        const fresh = await readCatalog("discover", scope, { forLaunchForm: true });
        if (!alive || epoch !== discoveryGeneration.current) return;
        // No prior catalog means no user selection to preserve. A genuinely
        // missing selection must instead stay visible until explicitly changed.
        const nextPipeline = pipeline || fresh.pipelines[0]?.id || "";
        const missingPipeline = !fresh.pipelines.some(
          (p) => p.id === nextPipeline,
        );
        const nextIndex = selectedTopic
          ? fresh.topics.findIndex(
              (t) =>
                t.branch === selectedTopic.branch &&
                t.topic === selectedTopic.topic,
            )
          : !data
            ? Math.max(
                0,
                fresh.topics.findIndex(
                  (t) =>
                    t.branch === (initial?.branch || fresh.currentBranch) &&
                    (!initial?.topic || t.topic === initial.topic),
                ),
              )
            : Number(topicIndex);
        if (
          !owner &&
          fresh.repository !== "missing" &&
          mode === "existing" &&
          nextIndex < 0
        )
          throw new Error(
            tr("launch.theSelectedTopicIsMissingFromTheRefreshed"),
          );
        // Publish the new catalog even when selection validation or preview fails.
        setCatalogSettled(catalogKey);
        setData(fresh);
        setTopicIndex(String(nextIndex));
        const missingProfile = missingProfileName(fresh, profile);
        if (missingPipeline || missingProfile) {
          currentBranchRef.current = fresh.currentBranch;
          setCards([]);
          setError(
            missingProfile
              ? tr("launch.profileMissingprofileWasNotFoundSelectADifferent", { missingProfile: missingProfile })
              : "",
          );
          initialSettingsRevision.current = settingsRevision;
          setAppliedCatalogEpoch(epoch);
          setSettingsRefreshing(false);
          setPending(false);
          return;
        }
        readingPreview = true;
        const complete = await readCatalog("preview", {
          projectId: project.id,
          ...(fresh.formReadId ? { formReadId: fresh.formReadId } : {}),
          ...(owner ? { context: contextRef(owner) } : {}),
          pipeline: nextPipeline,
          workflow,
          profile: profile === "__auto__" ? "" : profile,
          ...(profile === "__auto__" ? { profileMode: "auto" as const } : {}),
          skips: [],
        });
        if (!alive || epoch !== discoveryGeneration.current) return;
        currentBranchRef.current = fresh.currentBranch;
        setCards(complete.stages);
        // With no skipped stages this *is* the exact selection. Publish the
        // token atomically instead of issuing the same preview a second time.
        if (!skips.length) {
          const key = keyForPreview(nextPipeline, workflow, profile, skips, fresh);
          preparedPreviewKey.current = key;
          setPreview(complete);
          setReadyKey(key);
          setPreviewSettled(key);
          setPending(false);
        }
        setPipeline(nextPipeline);
        setError("");
        initialSettingsRevision.current = settingsRevision;
        setAppliedCatalogEpoch(epoch);
        setSettingsRefreshing(false);
      } catch (e) {
        if (!alive || epoch !== discoveryGeneration.current) return;
        // A valid catalog with an invalid composition remains editable, but
        // cannot launch until an explicit retry or selection change succeeds.
        failedRefreshKey.current = discoveryKey;
        setSettingsPreviewFailure(readingPreview);
        setSettingsRefreshError(message(e));
        setSettingsRefreshing(false);
        setPending(false);
      } finally {
        if (alive && epoch === discoveryGeneration.current)
          discoveryInFlight.current = false;
      }
    })();
    return () => {
      alive = false;
    };
  }, [discoveryKey, suspended]);
  const profileRequest =
    profile === "__auto__"
      ? { profile: "", profileMode: "auto" as const }
      : { profile };
  function keyForPreview(
    selectedPipeline: string, selectedWorkflow: string, selectedProfile: string,
    selectedSkips: string[], catalog: Discovery | null,
  ) {
    return JSON.stringify([
      ownerKey, selectedPipeline, selectedWorkflow, selectedProfile, selectedSkips,
      catalog?.currentBranch, catalog?.projectSettings?.version, settingsRevision,
      previewAttempt,
    ]);
  }
  const compositionKey = keyForPreview(pipeline, workflow, profile, skips, data);
  const readPreview = useReadScope(compositionKey);
  const [readyKey, setReadyKey] = useState("");
  const preparedPreviewKey = useRef<string | null>(null);
  useEffect(() => {
    const missingProfile = data && missingProfileName(data, profile);
    setPreviewError("");
    if (missingProfile) {
      generation.current++;
      setPreview(null);
      setReadyKey("");
      setCards([]);
      setPending(false);
      setPreviewSettled(compositionKey);
      setError(
        tr("launch.profileMissingprofileWasNotFoundSelectADifferent", { missingProfile: missingProfile }),
      );
      return;
    }
    if (
      !pipeline ||
      !data ||
      !data.pipelines.some((p) => p.id === pipeline) ||
      settingsRefreshing ||
      settingsRefreshError ||
      settingsRevision !== initialSettingsRevision.current
    )
      return;
    if (preparedPreviewKey.current === compositionKey) {
      preparedPreviewKey.current = null;
      return;
    }
    preparedPreviewKey.current = null;
    const epoch = ++generation.current;
    setPending(true);
    setPreview(null);
    setError("");
    readPreview("preview", {
      projectId: project.id,
      ...(formReadId ? { formReadId } : {}),
      ...(owner ? { context: contextRef(owner) } : {}),
      pipeline,
      workflow,
      ...profileRequest,
      skips,
    }).then(
      (p) => {
        if (epoch !== generation.current) return;
        setPreview(p);
        setReadyKey(compositionKey);
        setPreviewSettled(compositionKey);
        setPending(false);
        if (!skips.length) setCards(p.stages);
      },
      (e) => {
        if (epoch === generation.current) {
          setError(message(e));
          setPreviewError(message(e));
          setPreviewSettled(compositionKey);
          setPending(false);
        }
      },
    );
    return () => {
      generation.current++;
    };
  }, [
    compositionKey,
    settingsRefreshing,
    settingsRefreshError,
    appliedCatalogEpoch,
  ]);
  const resetComposition = (fn: () => void, local = false) => {
    setLaunchError("");
    generation.current++;
    setPreviewRefresh(local ? "pipeline" : null);
    setPending(true);
    setPreview(null);
    setReadyKey("");
    setCards([]);
    setSkips([]);
    setResetNote(tr("launch.stageSelectionsWereResetForTheNewSet"));
    fn();
    if (settingsPreviewFailure) setSettingsRefreshAttempt((n) => n + 1);
  };
  const topic = owner
    ? { topic: owner.topic, branch: owner.branch, remote: false }
    : data?.topics[Number(topicIndex)];
  useEffect(() => {
    if (
      repositoryMissing &&
      drafts.forms.get(storageKey)?.mode !== "none" &&
      drafts.forms.has(storageKey)
    )
      return;
    if (data)
      drafts.forms.set(storageKey, {
        mode,
        branch: topic?.branch ?? "",
        topic: topic?.topic,
        name,
        baseRef,
        profile,
      });
  }, [
    project.id,
    data,
    mode,
    topic?.branch,
    topic?.topic,
    name,
    baseRef,
    profile,
    repositoryMissing,
  ]);
  const taskKey =
    !data || mode === "none"
      ? null
      : JSON.stringify([
          ownerKey,
          mode,
          mode === "new" ? "draft" : topic?.branch,
          mode === "new" ? "" : topic?.topic,
        ]);
  const selectedTaskRequest = topic
    ? {
        projectId: project.id,
        ...(formReadId ? { formReadId } : {}),
        ...(owner ? { context: contextRef(owner) } : {}),
        branch: topic.branch,
        topic: topic.topic,
      }
    : null;
  const taskRequest = mode === "existing" ? selectedTaskRequest : null;
  // Prepare the selected topic under the same initial form loader, even when
  // starting without a topic. Switching modes then adopts this exact document
  // from the existing draft store, without a second read or replacing edits.
  const topicPreparationKey =
    !owner &&
    !suspended &&
    mode !== "existing" &&
    data &&
    data.pipelines.length > 0 &&
    topic
      ? JSON.stringify([ownerKey, "existing", topic.branch, topic.topic])
      : null;
  const topicPreparation = useTaskDraft(
    drafts,
    topicPreparationKey,
    selectedTaskRequest,
    false,
    suspended,
  );
  const topicPreparationPending =
    !!topicPreparationKey &&
    (!topicPreparation.draft || topicPreparation.draft.status === "loading");
  const editor = useTaskDraft(
    drafts,
    mode === "existing" && !topic ? null : taskKey,
    taskRequest,
    mode === "new",
    suspended,
  );
  const preparedSelection = useRef<number | null>(null),
    preparedText = useRef<number | null>(null);
  useEffect(() => {
    if (
      !preparedTopic ||
      !data ||
      settingsRefreshing ||
      preparedSelection.current === preparedTopic.nonce
    )
      return;
    const index = data.topics.findIndex(
      (t) =>
        t.branch === preparedTopic.target.branch &&
        t.topic === preparedTopic.target.topic &&
        !t.remote,
    );
    const exactOwner =
      owner &&
      owner.projectId === project.id &&
      owner.branch === preparedTopic.target.branch &&
      owner.topic === preparedTopic.target.topic &&
      !preparedTopic.target.remote;
    if ((owner && !exactOwner) || (!owner && index < 0)) {
      setResetNote(
        tr("launch.theSelectedTopicIsMissingFromTheLaunch"),
      );
      return;
    }
    preparedSelection.current = preparedTopic.nonce;
    setMode("existing");
    setTopicIndex(String(Math.max(0, index)));
  }, [preparedTopic, data, settingsRefreshing, ownerKey]);
  useEffect(() => {
    if (
      !preparedTopic ||
      preparedSelection.current !== preparedTopic.nonce ||
      preparedText.current === preparedTopic.nonce ||
      mode !== "existing" ||
      topic?.branch !== preparedTopic.target.branch ||
      topic?.topic !== preparedTopic.target.topic ||
      !editor.ready
    )
      return;
    preparedText.current = preparedTopic.nonce;
    onPrepared?.(preparedTopic.nonce);
    if (preparedTopic.text === undefined) return;
    if (editor.dirty && editor.draft?.text !== preparedTopic.text) {
      setResetNote(
        tr("launch.yourLaunchTaskDraftWasKeptTheTopic"),
      );
      return;
    }
    if (!editor.dirty && editor.draft?.text !== preparedTopic.text)
      editor.edit(preparedTopic.text);
  }, [
    preparedTopic,
    mode,
    topic?.branch,
    topic?.topic,
    editor.ready,
    editor.draft,
  ]);
  const [reloadConfirmation, setReloadConfirmation] = useState<{
    key: string | null;
    draft: TaskDraft;
  } | null>(null);
  useEffect(() => {
    // A delayed scope cleanup must not dismiss a confirmation just opened for
    // this exact draft after a reread failure became visible.
    setReloadConfirmation((current) =>
      current?.key === taskKey && current.draft === editor.draft
        ? current
        : null,
    );
  }, [taskKey, editor.draft]);
  const task = editor.draft?.text ?? "";
  const emptyReplacement =
    mode === "existing" &&
    editor.dirty &&
    !!editor.draft?.document?.text.trim() &&
    !task.trim();
  const taskReady =
    mode === "none" || (editor.ready && (!emptyReplacement || confirmEmpty));
  useEffect(() => {
    setConfirmEmpty(false);
  }, [taskKey]);

  const [resetting, setResetting] = useState(false);
  // Discovery may fail while the app still owns an unsaved memory draft.
  // Include that hidden draft in consent and concurrency checks as well.
  const rememberedKeys =
    !data && initial
      ? [...drafts.tasks.keys()].filter((key) => {
          try {
            const [id, kind, branch, topicId] = JSON.parse(key);
            return (
              id === ownerKey &&
              kind === mode &&
              (mode === "new" ||
                (branch === initial.branch &&
                  (!initial.topic || topicId === initial.topic)))
            );
          } catch {
            return false;
          }
        })
      : [];
  const resetTaskKey =
    taskKey ?? (rememberedKeys.length === 1 ? rememberedKeys[0] : null);
  const resetDraft = resetTaskKey ? drafts.tasks.get(resetTaskKey) : undefined;
  // Capture every resettable value and a monotonic identity. Returning to an
  // earlier selection must not revive an older operation or its consent.
  const formSignature = JSON.stringify([
    ownerKey,
    taskKey,
    mode,
    topic?.branch,
    topic?.topic,
    pipeline,
    workflow,
    profile,
    skips,
    name,
    baseRef,
    clean,
    confirmEmpty,
    data?.currentBranch,
  ]);
  const resetSignature = JSON.stringify([suspended, formSignature]);
  const resetSnapshot = useRef<{
    signature: string;
    draft: TaskDraft | undefined;
    data: Discovery | null;
    store: DraftStore;
  } | null>(null);
  if (
    resetSnapshot.current?.signature !== resetSignature ||
    resetSnapshot.current.draft !== resetDraft ||
    resetSnapshot.current.data !== data ||
    resetSnapshot.current.store !== drafts
  )
    resetSnapshot.current = {
      signature: resetSignature,
      draft: resetDraft,
      data,
      store: drafts,
    };
  const snapshot = resetSnapshot.current;
  const [resetConfirmation, setResetConfirmation] = useState<
    typeof snapshot | null
  >(null);
  const resetOperation = useRef<object | null>(null);
  useEffect(() => {
    setResetConfirmation(null);
    resetOperation.current = null;
    setResetting(false);
    return () => {
      resetOperation.current = null;
    };
  }, [snapshot]);
  const resetDirty =
    editor.dirty ||
    rememberedKeys.some((key) => {
      const draft = drafts.tasks.get(key)!;
      return draft.text !== (draft.document?.text ?? "");
    }) ||
    pipeline !== (data?.pipelines[0]?.id ?? "") ||
    workflow !== "auto" ||
    profile !== "" ||
    skips.length > 0 ||
    clean ||
    confirmEmpty ||
    (mode === "new" && (name !== "" || baseRef !== "HEAD"));

  async function resetForm(expected = snapshot) {
    if (
      !mounted.current ||
      settingsRefreshing ||
      launching ||
      launchInFlight.current ||
      (!data && discoveryInFlight.current) ||
      resetOperation.current ||
      resetDraft?.status === "loading" ||
      (resetTaskKey && drafts.tasks.get(resetTaskKey) !== expected.draft) ||
      resetSnapshot.current !== expected
    )
      return;
    const operation = {};
    const epoch = ++discoveryGeneration.current;
    discoveryInFlight.current = true;
    const originalForm = drafts.forms.get(storageKey);
    const current = () =>
      mounted.current &&
      epoch === discoveryGeneration.current &&
      resetOperation.current === operation &&
      resetSnapshot.current === expected &&
      drafts.forms.get(storageKey) === originalForm &&
      (!resetTaskKey || drafts.tasks.get(resetTaskKey) === expected.draft);
    resetOperation.current = operation;
    setResetting(true);
    setResetConfirmation(null);
    setReloadConfirmation(null);
    setError("");
    try {
      const fresh = await read("discover", scope, { forLaunchForm: true });
      if (!current()) return;
      let index = Number(topicIndex);
      let nextMode =
        !owner && fresh.repository === "missing" ? ("none" as const) : mode;
      if (nextMode === "existing") {
        if (data && !topic)
          throw new Error(
            tr("launch.theSelectedTopicIsMissingSelectItAgain"),
          );
        const selectedContext = topic ?? (initial?.branch ? initial : null);
        if (selectedContext) {
          const matches = fresh.topics.flatMap((candidate, i) =>
            candidate.branch === selectedContext.branch &&
            (!selectedContext.topic ||
              candidate.topic === selectedContext.topic)
              ? [i]
              : [],
          );
          if (!owner && matches.length !== 1)
            throw new Error(
              matches.length
                ? tr("launch.theSelectedTopicIsAmbiguousInTheRefreshed")
                : tr("launch.theSelectedTopicIsMissingFromTheRefreshed2"),
            );
          index = matches[0] ?? 0;
        } else {
          // No selected or remembered context exists after initial discovery failure.
          index = Math.max(
            0,
            fresh.topics.findIndex(
              (t) => t.branch === (initial?.branch || fresh.currentBranch),
            ),
          );
          if (!fresh.topics.length) nextMode = "new";
        }
      }
      const nextPipeline = fresh.pipelines[0]?.id;
      if (!nextPipeline)
        throw new Error(tr("launch.gogaDidNotReturnAnyAvailablePipelines"));
      const selected = owner
        ? { topic: owner.topic, branch: owner.branch }
        : fresh.topics[index];
      const nextKey = JSON.stringify([
        ownerKey,
        nextMode,
        nextMode === "new" ? "draft" : selected?.branch,
        nextMode === "new" ? "" : selected?.topic,
      ]);
      const previousTarget = drafts.tasks.get(nextKey);
      const document =
        nextMode === "existing"
          ? await read("readTopicTask", {
              projectId: project.id,
              ...(fresh.formReadId ? { formReadId: fresh.formReadId } : {}),
              ...(owner ? { context: contextRef(owner) } : {}),
              branch: selected.branch,
              topic: selected.topic,
            })
          : undefined;
      if (!current() || drafts.tasks.get(nextKey) !== previousTarget) return;
      const prepared = await read("preview", {
        projectId: project.id,
        ...(fresh.formReadId ? { formReadId: fresh.formReadId } : {}),
        ...(owner ? { context: contextRef(owner) } : {}),
        pipeline: nextPipeline,
        workflow: "auto",
        profile: "",
        skips: [],
      });
      if (!current() || drafts.tasks.get(nextKey) !== previousTarget) return;
      const nextCompositionKey = keyForPreview(nextPipeline, "auto", "", [], fresh);
      // No await after this point: publish one prepared state, never a partial reset.
      generation.current++;
      // Clearing a failed refresh also re-arms the preview effect, even when
      // the default selections did not change. Reset already read that exact
      // preview and its catalog for this revision.
      preparedPreviewKey.current =
        nextCompositionKey !== compositionKey || settingsRefreshError
          ? nextCompositionKey : null;
      initialSettingsRevision.current = settingsRevision;
      failedRefreshKey.current = undefined;
      setSettingsRefreshError("");
      setSettingsPreviewFailure(false);
      if (nextMode !== "none")
        drafts.tasks.set(nextKey, {
          text: document?.text ?? "",
          document,
          status: "ready",
          error: "",
        });
      if (!(
        fresh.repository === "missing" &&
        originalForm &&
        originalForm.mode !== "none"
      ))
        drafts.forms.set(storageKey, {
          mode: nextMode,
          branch: selected?.branch ?? "",
          topic: selected?.topic,
          name: nextMode === "new" ? "" : name,
          baseRef: nextMode === "new" ? "HEAD" : baseRef,
        });
      currentBranchRef.current = fresh.currentBranch;
      setData(fresh);
      setCatalogSettled(catalogKey);
      setTopicIndex(String(index));
      setMode(nextMode);
      setPipeline(nextPipeline);
      setWorkflow("auto");
      setProfile("");
      setSkips([]);
      if (nextMode === "new") {
        setName("");
        setBaseRef("HEAD");
      }
      setClean(false);
      setConfirmEmpty(false);
      setPreview(prepared);
      setPreviewRefresh(null);
      setReadyKey(nextCompositionKey);
      setPreviewSettled(nextCompositionKey);
      setPreviewError("");
      setCards(prepared.stages);
      setPending(false);
      setResetNote("");
      setError("");
      setLaunchError("");
      drafts.listeners.forEach((fn) => fn());
    } catch (e) {
      if (current()) setError(preparationErrorMessage(e));
    } finally {
      if (epoch === discoveryGeneration.current)
        discoveryInFlight.current = false;
      if (resetOperation.current === operation) {
        resetOperation.current = null;
        if (mounted.current) setResetting(false);
      }
    }
  }

  const switchRequired =
    !owner &&
    (mode === "new" ||
      (mode === "existing" && !!topic && topic.branch !== data?.currentBranch));
  function updateBranch(currentBranch: string) {
    if (currentBranchRef.current === currentBranch) return;
    currentBranchRef.current = currentBranch;
    resetComposition(() =>
      setData((previous) =>
        previous ? { ...previous, currentBranch } : previous,
      ),
    );
    setConfirmEmpty(false);
    setClean(false);
  }
  useEffect(() => {
    if (!data || launching || suspended || settingsRefreshing) return;
    let alive = true;
    const refresh = () => {
      read("checkoutBranch", scope).then(
        (branch) => {
          if (alive && branch !== data.currentBranch) {
            updateBranch(branch);
            setError(
              tr("launch.theCurrentBranchChangedReviewTheSettingsAnd"),
            );
          }
        },
        (e) => {
          if (alive) {
            setError(message(e));
          }
        },
      );
    };
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
    };
  }, [
    project.id,
    data?.currentBranch,
    launching,
    suspended,
    settingsRefreshing,
  ]);
  const launchReady =
    !blocked &&
    !settingsRefreshing &&
    !settingsRefreshError &&
    !!data &&
    !missingProfileName(data, profile) &&
    settingsRevision === initialSettingsRevision.current &&
    !!preview &&
    readyKey === compositionKey &&
    !pending &&
    !topicPreparationPending &&
    preview.stages.length > 0;
  const ready = !suspended && launchReady;
  const validTopic =
    mode === "none" || (mode === "new" ? name.trim().length > 0 : !!topic);
  // Identity is monotonic even for A→B→A changes. Consent never attaches to
  // a later draft, preview or catalog that merely has equivalent visible text.
  const launchSignature = JSON.stringify([
    formSignature,
    settingsRevision,
    validTopic,
    taskReady,
    preview?.token,
    task,
  ]);
  const launchContext = useRef<{
    signature: string;
    draft: TaskDraft | undefined;
    data: Discovery | null;
    preview: Preview | null;
    store: DraftStore;
  } | null>(null);
  if (
    !launchContext.current ||
    launchContext.current.signature !== launchSignature ||
    launchContext.current.draft !== editor.draft ||
    launchContext.current.data !== data ||
    launchContext.current.preview !== preview ||
    launchContext.current.store !== drafts
  )
    launchContext.current = {
      signature: launchSignature,
      draft: editor.draft,
      data,
      preview,
      store: drafts,
    };
  const launchSnapshot = launchContext.current;
  // An accepted operation owns an immutable request. Only genuine draft edits
  // protect a newer draft from its completion; presentation refreshes do not.
  const draftIntentSignature = JSON.stringify([
    ownerKey,
    mode,
    pipeline,
    workflow,
    profile,
    skips,
    clean,
    confirmEmpty,
    mode === "existing" ? [topic?.branch, topic?.topic] : null,
    mode === "new" ? [name, baseRef] : null,
  ]);
  const draftIntentRef = useRef<{
    signature: string;
    draft: TaskDraft | undefined;
    store: DraftStore;
  } | null>(null);
  if (
    !draftIntentRef.current ||
    draftIntentRef.current.signature !== draftIntentSignature ||
    draftIntentRef.current.draft !== editor.draft ||
    draftIntentRef.current.store !== drafts
  )
    draftIntentRef.current = {
      signature: draftIntentSignature,
      draft: editor.draft,
      store: drafts,
    };
  const draftIntent = draftIntentRef.current;
  type LaunchIntent = {
    context: typeof launchSnapshot;
    draftContext: typeof draftIntent;
    request: LaunchRequest;
    saveTask: boolean;
    from: string;
    creating: boolean;
  };
  const pendingLaunch = useRef<LaunchIntent | null>(null);
  const [launchConfirmation, setLaunchConfirmation] =
    useState<LaunchIntent | null>(null);
  useEffect(() => {
    pendingLaunch.current = null;
    setLaunchConfirmation(null);
  }, [launchSnapshot, suspended]);
  const canLaunch =
    ready &&
    !!preview &&
    validTopic &&
    !!data &&
    !launching &&
    !resetting &&
    taskReady;
  function requestLaunch(update: boolean) {
    if (
      !canLaunch ||
      !preview ||
      !data ||
      launchInFlight.current ||
      resetOperation.current
    )
      return;
    const selectedPipeline = data.pipelines.find(
      (item) => item.id === pipeline,
    );
    const intent: LaunchIntent = {
      context: launchSnapshot,
      draftContext: draftIntent,
      creating: mode === "new",
      from:
        mode === "new"
          ? baseRef === "HEAD"
            ? data.currentBranch
            : baseRef
          : data.currentBranch,
      saveTask: editor.dirty,
      request: {
        expectedBranch: data.currentBranch,
        confirmBranchSwitch: switchRequired,
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        pipeline,
        ...pipelineDisplayMetadata({
          pipelineName: selectedPipeline?.name,
          pipelineDescription: selectedPipeline?.description,
        }),
        workflow,
        ...profileRequest,
        skips: [...skips],
        previewToken: preview.token,
        task,
        ...(mode === "existing" && editor.dirty
          ? { taskVersion: editor.draft!.document!.version }
          : {}),
        confirmEmptyTask: mode !== "none" && confirmEmpty,
        clean,
        update,
        topic:
          mode === "none"
            ? { mode: "none" }
            : mode === "new"
              ? { mode: "new", name: name.trim(), baseRef }
              : {
                  mode: "existing",
                  branch: topic!.branch,
                  topic: topic!.topic,
                },
      },
    };
    pendingLaunch.current = intent;
    if (switchRequired) setLaunchConfirmation(intent);
    else void executeLaunch(intent);
  }
  function cancelLaunch() {
    pendingLaunch.current = null;
    setLaunchConfirmation(null);
  }
  async function executeLaunch(intent: LaunchIntent) {
    if (
      !mounted.current ||
      pendingLaunch.current !== intent ||
      launchContext.current !== intent.context ||
      !canLaunch ||
      launchInFlight.current ||
      resetOperation.current
    )
      return;
    pendingLaunch.current = null;
    setLaunchConfirmation(null);
    launchInFlight.current = true;
    const submittedForm = drafts.forms.get(storageKey);
    const preserveTopicForm =
      repositoryMissing && submittedForm?.mode !== "none";
    setLaunching(true);
    onLaunchStarted?.();
    setError("");
    setLaunchError("");
    try {
      // This preflight belongs to the accepted operation, not a cancellable
      // view read. Navigation, UI busy flags and preview refreshes cannot revoke
      // it; Host validates the captured exact owner and request.
      const branch = await readRequest(
        "checkoutBranch",
        intent.request.context ?? intent.request.projectId,
      );
      if (branch !== intent.request.expectedBranch) {
        if (mounted.current && draftIntentRef.current === intent.draftContext)
          updateBranch(branch);
        throw new Error(
          tr("launch.theCurrentBranchChangedReviewTheSettingsAnd"),
        );
      }
      const run = await window.goga.launch(intent.request);
      const stale =
        !mounted.current || draftIntentRef.current !== intent.draftContext;
      if (!stale) {
        editor.clear();
        // Catalog refresh can recreate this presentation record unchanged.
        if (
          !preserveTopicForm &&
          JSON.stringify(drafts.forms.get(storageKey)) ===
            JSON.stringify(submittedForm)
        )
          drafts.forms.delete(storageKey);
      }
      // The source App still registers the exact result even if this view was
      // unmounted; a genuine newer draft remains protected by stale=true.
      await onLaunched(run, stale);
    } catch (e) {
      if (mounted.current && draftIntentRef.current === intent.draftContext) {
        setLaunchError(message(e));
        try {
          const branch = await read(
            "checkoutBranch",
            intent.request.context ?? intent.request.projectId,
          );
          if (
            mounted.current &&
            draftIntentRef.current === intent.draftContext &&
            branch !== intent.request.expectedBranch
          )
            updateBranch(branch);
        } catch {}
      }
    } finally {
      if (intent.request.topic.mode === "new") onTopicsChanged?.();
      launchInFlight.current = false;
      if (mounted.current) {
        setClean(false);
        setLaunching(false);
      }
    }
  }
  useEffect(() => {
    onBusyChange?.(storageKey, launching || resetting);
    return () => onBusyChange?.(storageKey, false);
  }, [storageKey, launching, resetting, onBusyChange]);
  const catalogLoading =
    !data && (discoveryInFlight.current || catalogSettled !== catalogKey);
  const validComposition =
    !!data &&
    data.pipelines.some((p) => p.id === pipeline) &&
    !missingProfileName(data, profile);
  const taskLoading =
    topicPreparationPending ||
    (!!data &&
      data.pipelines.length > 0 &&
      (mode === "new" || (mode === "existing" && !!topic)) &&
      (!editor.draft || editor.draft.status === "loading"));
  const loadFailure =
    (!data && !catalogLoading ? error : "") ||
    (!settingsPreviewFailure ? settingsRefreshError : "") ||
    (editor.draft?.status === "error" ? editor.draft.error : "");
  const correctionError =
    launchError || (settingsPreviewFailure ? settingsRefreshError : error);
  const formLoading =
    !suspended &&
    !loadFailure &&
    (catalogLoading ||
      settingsRefreshing ||
      (!settingsRefreshError &&
        settingsRevision !== initialSettingsRevision.current) ||
      (validComposition &&
        !previewRefresh &&
        !settingsRefreshError &&
        (pending || previewSettled !== compositionKey)) ||
      (taskLoading &&
        !settingsPreviewFailure &&
        !(previewSettled === compositionKey && previewError)));
  const pipelineRefresh = previewRefresh === "pipeline";
  const stageLoading =
    pipelineRefresh &&
    !formLoading &&
    validComposition &&
    !settingsRefreshError &&
    (pending || previewSettled !== compositionKey);
  const stageError =
    pipelineRefresh &&
    !loadFailure &&
    !pending &&
    previewSettled === compositionKey
      ? previewError
      : "";
  function retryPreparation() {
    if (editor.draft?.status === "error" || editor.draft?.status === "loading")
      void editor.retry();
    if (settingsRefreshError) setSettingsRefreshAttempt((n) => n + 1);
    else if (!data) setCatalogAttempt((n) => n + 1);
    else setPreviewAttempt((n) => n + 1);
  }
  return (
    <section
      className="launch-panel"
      aria-busy={formLoading || launching || resetting}
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">{tr("launch.gogaNewRun")}</span>
          <h2>{tr("launch.launchPipeline")}</h2>
        </div>
        <button
          onClick={onCancel}
          disabled={launching || resetting}
          aria-label={tr("launch.closeForm")}
          className="quiet"
        >
          ✕
        </button>
      </div>
      <LoadingBoundary
        pending={formLoading || launching}
        label={
          launching
            ? tr("launch.preparingRun")
            : tr("launch.loadingPipelineSettings")
        }
        error={loadFailure}
        retryLabel={
          settingsRefreshError ? tr("launch.retryCatalogRefresh") : undefined
        }
        onRetry={retryPreparation}
      >
        {!data ? (
          <div className="loading">
            {error
              ? tr("launch.couldNotLoadTheCatalog")
              : tr("launch.readingTheGogaCatalogThisMayTakeA")}
          </div>
        ) : (
          <fieldset disabled={launching || suspended || settingsRefreshing}>
            <SearchablePicker
              label={tr("launch.pipeline")}
              placeholder={tr("launch.selectAPipeline")}
              emptyLabel={tr("launch.selectAPipeline")}
              searchLabel={tr("launch.searchPipelines")}
              searchPlaceholder={tr("launch.findPipeline")}
              listLabel={tr("launch.pipelines2")}
              value={pipeline}
              disabled={launching || suspended || settingsRefreshing}
              onChange={(value) =>
                resetComposition(() => setPipeline(value), true)
              }
              entries={[
                ...(pipeline && !data.pipelines.some((p) => p.id === pipeline)
                  ? [
                      {
                        value: pipeline,
                        label: tr("launch.pipelineNotFoundSelectAnotherPipeline", { pipeline: pipeline }),
                      },
                    ]
                  : []),
                ...(!pipeline
                  ? [{ value: "", label: tr("launch.selectAPipeline") }]
                  : []),
                ...data.pipelines.map((p) => ({
                  value: p.id,
                  label: p.id + (p.project ? tr("launch.project") : ""),
                })),
              ]}
            />
            {pipeline && !data.pipelines.some((p) => p.id === pipeline) && (
              <p className="error" role="alert">{tr("launch.theSelectedPipelineIsMissingFromTheRefreshed")}</p>
            )}
            {!data.pipelines.length && (
              <p className="error" role="alert">{tr("launch.gogaDidNotReturnAnyAvailablePipelines")}</p>
            )}
            <p className="hint pipeline-description">
              {data.pipelines.find((p) => p.id === pipeline)?.description}
            </p>
            {!owner && (
              <div className="topic-block">
                <fieldset className="topic-mode">
                  <legend>{tr("launch.runIn")}</legend>
                  <label>
                    <input
                      type="radio"
                      name={topicModeName}
                      checked={mode === "none"}
                      onChange={() => setMode("none")}
                    />{tr("launch.noTopic")}</label>
                  <label>
                    <input
                      type="radio"
                      name={topicModeName}
                      checked={mode === "existing"}
                      disabled={repositoryMissing}
                      onChange={() => {
                        setMode("existing");
                      }}
                    />{tr("launch.existing")}</label>
                  <label>
                    <input
                      type="radio"
                      name={topicModeName}
                      checked={mode === "new"}
                      disabled={repositoryMissing}
                      onChange={() => {
                        setMode("new");
                      }}
                    />{tr("launch.createNew")}</label>
                </fieldset>
                {mode === "none" ? (
                  <p className="hint">
                    {repositoryMissing ? (
                      tr("launch.originalProjectFolderGitIsNotInitializedSo")
                    ) : (
                      tr("launch.originalBranchSummary", { branch: data.currentBranch || tr("launch.detachedHead") })
                    )}
                  </p>
                ) : mode === "existing" ? (
                  <>
                    <TopicSelect
                      topics={data.topics}
                      value={topicIndex}
                      currentBranch={data.currentBranch}
                      disabled={launching}
                      onChange={(value) => {
                        setTopicIndex(value);
                      }}
                    />
                    {onOpenTopic && topic?.topic && (
                      <button
                        type="button"
                        className="topic-link launch-topic-link"
                        disabled={launching || !editor.ready}
                        onClick={() =>
                          onOpenTopic(
                            topic,
                            editor.draft?.text ?? "",
                            false,
                            editor.edit,
                          )
                        }
                      >{tr("launch.selectedTopicForLaunch", { topic: topic.topic })} ↗
                      </button>
                    )}
                    {!topic?.topic && (
                      <p className="hint">{tr("launch.thisBranchHasNoTopicOfItsOwn")}</p>
                    )}
                  </>
                ) : (
                  <div className="topic-new-row">
                    <label>{tr("launch.newTopicName")}<input
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value);
                        }}
                        placeholder="feature/export-report"
                        maxLength={120}
                      />
                      {onOpenTopic && name && (
                        <button
                          type="button"
                          className="topic-link launch-topic-link"
                          disabled={launching || !editor.ready}
                          onClick={() =>
                            onOpenTopic(
                              {
                                topic: name
                                  .toLowerCase()
                                  .replace(/[^\x00-\x7f]/g, "")
                                  .replace(/[^a-z0-9]+/g, "-")
                                  .replace(/^-|-$/g, ""),
                                branch: name,
                                remote: false,
                              },
                              editor.draft?.text ?? "",
                              true,
                              editor.edit,
                            )
                          }
                        >{tr("launch.newTopicViewTask")}</button>
                      )}
                    </label>
                    <SearchablePicker
                      label={tr("launch.sourceBranch")}
                      placeholder={tr("launch.selectASourceBranch")}
                      emptyLabel={tr("launch.noBranchesAvailable")}
                      searchLabel={tr("launch.searchSourceBranches")}
                      searchPlaceholder={tr("launch.findBranch")}
                      listLabel={tr("launch.sourceBranches")}
                      value={baseRef}
                      disabled={launching || suspended || settingsRefreshing}
                      onChange={setBaseRef}
                      entries={[
                        {
                          value: "HEAD",
                          label: tr("launch.value1Current", { value1: data.currentBranch || tr("launch.detachedHead") }),
                        },
                        ...(data.baseRef
                          ? [
                              {
                                value: data.baseRef,
                                label: tr("launch.baserefBase", { baseRef: data.baseRef }),
                              },
                            ]
                          : []),
                        ...data.branches
                          .filter((b) => b !== data.baseRef)
                          .map((b) => ({
                            value: b,
                            label:
                              b +
                              (b === data.currentBranch ? tr("launch.current") : ""),
                          })),
                      ]}
                    />
                  </div>
                )}
                <div
                  className="topic-context"
                  aria-live="polite"
                  aria-label={tr("launch.currentCheckedOutBranchValue1", { value1: data.currentBranch || tr("launch.detachedHead") })}
                  title={tr("launch.currentCheckedOutBranchValue1", { value1: data.currentBranch || tr("launch.detachedHead") })}
                >
                  {mode === "new" ? (
                    <span>{tr("launch.newTopicWorkingCopySummary", {
                      topic: name.trim() || "…",
                      base: baseRef === "HEAD" ? data.currentBranch || tr("launch.detachedHead") : baseRef,
                    })}</span>
                  ) : mode === "none" ? (
                    <span>{tr("launch.runInTheOriginalProjectFolder")}</span>
                  ) : topic ? (
                    switchRequired ? (
                      <span>{tr("launch.switchBranchSummary", {
                        from: data.currentBranch || tr("launch.detachedHead"), to: topic.branch,
                      })}</span>
                    ) : (
                      <span>{tr("launch.noSwitchRequired")}</span>
                    )
                  ) : (
                    <span>{tr("launch.selectATopic")}</span>
                  )}
                </div>
                <p className="hint">{tr("launch.oneActiveRunPerProjectOtherProjectsRun")}</p>
              </div>
            )}
            {owner && (
              <p className="hint">{tr("launch.workingCopyDraftSummary", { topic: owner.topic })}</p>
            )}
            {blocked && (
              <p className="error" role="status">
                {typeof blocked === "string"
                  ? blocked
                  : tr("launch.runsAreTemporarilyUnavailableInThisWorkingCopy")}
              </p>
            )}
            {mode !== "none" && (
              <details
                key={taskKey ?? ownerKey}
                className="task-editor"
                aria-busy={editor.draft?.status === "loading"}
              >
                <summary>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>{tr("launch.whatNeedsToBeDone")}</summary>
                <textarea
                  aria-label={tr("launch.whatNeedsToBeDone")}
                  rows={5}
                  value={task}
                  disabled={!editor.ready}
                  maxLength={100000}
                  onChange={(e) => {
                    editor.edit(e.target.value);
                    setConfirmEmpty(false);
                  }}
                  placeholder={
                    mode === "new" ? tr("launch.describeTheTaskForTheNewTopic") : ""
                  }
                />
                {editor.draft?.status === "loading" && (
                  <p className="hint" role="status">{tr("launch.readingTheSelectedTopicSTask")}</p>
                )}
                {mode === "existing" && editor.ready && (
                  <p className="hint">
                    {owner &&
                    editor.draft?.document?.catalogState ===
                      "missing-local-metadata"
                      ? tr("launch.topicDataHasNotBeenCreatedInThis")
                      : !editor.draft?.document?.exists
                        ? tr("launch.taskFileDoesNotExist")
                        : editor.draft.document.text === ""
                          ? tr("launch.taskFileIsEmpty")
                          : tr("launch.fullTaskContentLoaded")}{" "}
                    {topic?.branch !== data.currentBranch &&
                      tr("launch.forAnotherBranchThisIsTheVersionSaved")}
                  </p>
                )}
                <p className="hint">
                  {mode === "new"
                    ? tr("launch.theTaskWillBeWrittenToTheNew")
                    : editor.dirty
                      ? tr("launch.thereAreUnsavedChangesTheyWillBeWritten")
                      : tr("launch.noChangesLaunchingWillNotOverwriteTodoMd")}{" "}{tr("launch.draftsStayInMemoryUntilYouCloseThe")}</p>
                {mode === "existing" && (
                  <button
                    type="button"
                    className="quiet"
                    disabled={resetting || editor.draft?.status === "loading"}
                    onClick={() => {
                      if (resetOperation.current) return;
                      if (editor.dirty && editor.draft) {
                        setReloadConfirmation({
                          key: taskKey,
                          draft: editor.draft,
                        });
                      } else {
                        setConfirmEmpty(false);
                        void editor.reload();
                      }
                    }}
                  >{tr("launch.reloadTask")}</button>
                )}
              </details>
            )}
            {editor.draft?.error && editor.draft.status !== "error" && (
              <p className="error" role="alert">{tr("launch.couldNotReadTheTask")}{editor.draft.error}
              </p>
            )}
            {emptyReplacement && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmEmpty}
                  onChange={(e) => setConfirmEmpty(e.target.checked)}
                />{tr("launch.iConfirmSavingAnEmptyTask")}</label>
            )}
            <div className="form-divider" />
            <div className="form-grid">
              <SearchablePicker
                label={tr("launch.workflow")}
                placeholder={tr("launch.selectAWorkflow")}
                emptyLabel={tr("launch.noWorkflows")}
                searchLabel={tr("launch.searchWorkflows")}
                searchPlaceholder={tr("launch.findWorkflow")}
                listLabel={tr("launch.workflows")}
                value={workflow}
                disabled={launching || suspended || settingsRefreshing}
                onChange={(value) =>
                  resetComposition(() => setWorkflow(value), true)
                }
                entries={[
                  {
                    value: "auto",
                    label: tr("launch.automaticByPipelineName"),
                  },
                  { value: "none", label: tr("launch.noWorkflow") },
                  ...data.workflows.map((w) => ({
                    value: `file:${w}`,
                    label: w,
                  })),
                ]}
              />
              <SearchablePicker
                label={tr("launch.profile")}
                placeholder={tr("launch.selectAProfile")}
                emptyLabel={tr("launch.noProfiles")}
                searchLabel={tr("launch.searchProfiles")}
                searchPlaceholder={tr("launch.findProfile")}
                listLabel={tr("launch.profiles")}
                value={profile}
                disabled={launching || suspended || settingsRefreshing}
                onChange={(value) =>
                  resetComposition(() => setProfile(value), true)
                }
                entries={[
                  ...(data.projectSettings
                    ? [
                        {
                          value: "",
                          label: tr("launch.projectDefaultValue1Value2", { value1: data.projectSettings.profile || tr("launch.automatic2"), value2: data.projectSettings.profile &&
                            !data.profiles.some(
                              (item) =>
                                item.name === data.projectSettings!.profile,
                            )
                              ? tr("launch.missingProfileSuffix")
                              : "" }),
                        },
                        {
                          value: "__auto__",
                          label: tr("launch.automaticEnvironmentWorkflow"),
                        },
                      ]
                    : [
                        {
                          value: "",
                          label: tr("launch.automaticEnvironmentWorkflow"),
                        },
                      ]),
                  ...(profile &&
                  profile !== "__auto__" &&
                  !data.profiles.some((p) => p.name === profile)
                    ? [{ value: profile, label: tr("launch.profileNotFound", { profile: profile }) }]
                    : []),
                  ...data.profiles.map((p) => ({
                    value: p.name,
                    label: `${p.name} · ${p.source === "project" ? tr("launch.project2") : tr("launch.personal")}`,
                  })),
                ]}
              />
            </div>
            <p className="applied">{tr("launch.workflow2")}{" "}
              <strong>
                {pending
                  ? tr("launch.checking")
                  : (preview?.workflow ?? tr("launch.noWorkflow2"))}
              </strong>
              <span>{tr("launch.profile2")}{" "}
                <strong>
                  {pending
                    ? tr("launch.checking")
                    : (preview?.profile ?? tr("launch.notActive"))}
                </strong>
              </span>
            </p>
            <section className="pipeline-stages" aria-label={tr("launch.runStages")}>
              <div className="section-heading compact">
                <h3>{tr("launch.runStages")}</h3>
                <span className="hint" aria-live="polite">
                  {pending
                    ? tr("launch.gettingStagesFromGoga")
                    : tr("launch.value1Selected", { value1: preview?.stages.length ?? 0 })}
                </span>
              </div>
              <LoadingBoundary
                pending={stageLoading}
                label={tr("launch.loadingPipelineStages")}
                error={stageError}
                onRetry={retryPreparation}
              >
                <div className="stage-cards" aria-busy={pending}>
                  {cards.map((stage) => (
                    <label
                      key={stage.id}
                      className={`stage-card ${skips.includes(stage.id) ? "skipped" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={!skips.includes(stage.id)}
                        onChange={(e) => {
                          generation.current++;
                          setPreviewRefresh("stages");
                          setPending(true);
                          setPreview(null);
                          setReadyKey("");
                          setSkips((s) =>
                            e.target.checked
                              ? s.filter((id) => id !== stage.id)
                              : [...s, stage.id],
                          );
                        }}
                      />
                      <span>
                        <strong>{stage.id}</strong>
                        {stage.title && <small>{stage.title}</small>}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="hint">{tr("launch.uncheckAStageToSkipItForThis")}</p>
                {resetNote && <p className="hint">{resetNote}</p>}
                {!pending && preview && !preview.stages.length && (
                  <p role="alert" className="error">{tr("launch.selectAtLeastOneStageToLaunch")}</p>
                )}
              </LoadingBoundary>
            </section>
            <label className="check-row">
              <input
                type="checkbox"
                checked={clean}
                aria-describedby="clean-warning"
                onChange={(e) => setClean(e.target.checked)}
              />{tr("launch.startWithACleanState")}</label>
            <p id="clean-warning" className="hint">{tr("launch.theSavedStateOfThisPipelineWillBe")}</p>
          </fieldset>
        )}
        {data && correctionError && !loadFailure && !stageError && (
          <div role="alert" className="error">
            {correctionError}
          </div>
        )}
        {data && correctionError && !pending && !stageError && (
          <button type="button" onClick={retryPreparation}>
            {settingsRefreshError
              ? tr("launch.retryCatalogRefresh")
              : tr("launch.retryLoading")}
          </button>
        )}
      </LoadingBoundary>
      {reloadConfirmation &&
        reloadConfirmation.key === taskKey &&
        reloadConfirmation.draft === editor.draft && (
          <TaskReloadConfirmation
            onCancel={() => setReloadConfirmation(null)}
            onConfirm={() => {
              setReloadConfirmation(null);
              setConfirmEmpty(false);
              void editor.reload(reloadConfirmation.draft);
            }}
          />
        )}
      {launchConfirmation && launchConfirmation.context === launchSnapshot && (
        <BranchLaunchConfirmation
          creating={launchConfirmation.creating}
          branch={
            launchConfirmation.request.topic.mode === "new"
              ? launchConfirmation.request.topic.name
              : launchConfirmation.request.topic.mode === "existing"
                ? launchConfirmation.request.topic.branch
                : launchConfirmation.request.expectedBranch
          }
          from={launchConfirmation.from}
          update={!!launchConfirmation.request.update}
          saveTask={launchConfirmation.saveTask}
          onCancel={cancelLaunch}
          onConfirm={() => void executeLaunch(launchConfirmation)}
        />
      )}
      {resetConfirmation && resetConfirmation === snapshot && (
        <TaskReloadConfirmation
          resetForm
          onCancel={() => setResetConfirmation(null)}
          onConfirm={() => void resetForm(resetConfirmation)}
        />
      )}
      <div className="form-actions" hidden={formLoading || launching}>
        <button
          className="quiet"
          onClick={() => {
            if (
              settingsRefreshing ||
              launching ||
              launchInFlight.current ||
              (!data && discoveryInFlight.current) ||
              resetOperation.current ||
              (resetTaskKey &&
                drafts.tasks.get(resetTaskKey)?.status === "loading")
            )
              return;
            setReloadConfirmation(null);
            if (resetDirty) setResetConfirmation(snapshot);
            else void resetForm();
          }}
          disabled={
            settingsRefreshing ||
            launching ||
            resetting ||
            editor.draft?.status === "loading"
          }
        >{tr("launch.reset")}</button>
        <SplitLaunchButton
          disabled={!canLaunch}
          busy={launching}
          dirty={mode === "existing" && editor.dirty}
          context={launchSnapshot}
          onLaunch={requestLaunch}
        />
      </div>
    </section>
  );
}
