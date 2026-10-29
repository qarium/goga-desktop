import { preparationErrorMessage } from "./preparation-error";
import type { TopicContextRef } from "../shared/worktrees";
import { contextRef, contextRequestKey, draftKey } from "./topic-context";
import { useReadScope } from "./read-request";
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
  onCancel,
  draftStore,
  settingsRevision,
  suspended = false,
  preparedTopic,
  onOpenTopic,
  onPrepared,
  onBusyChange,
}: {
  project: Project;
  owner?: TopicContextRef;
  blocked?: boolean | string;
  onLaunched: (run: Run, stale?: boolean) => void;
  onCancel: () => void;
  onBusyChange?: (projectId: string, busy: boolean) => void;
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
  const [data, setData] = useState<Discovery | null>(null),
    [error, setError] = useState(""),
    [pipeline, setPipeline] = useState("");
  const [workflow, setWorkflow] = useState("auto"),
    [profile, setProfile] = useState(initial?.profile ?? ""),
    [skips, setSkips] = useState<string[]>([]);
  const [mode, setMode] = useState<"existing" | "new">(
      owner ? "existing" : (initial?.mode ?? "existing"),
    ),
    [topicIndex, setTopicIndex] = useState("0"),
    [name, setName] = useState(initial?.name ?? ""),
    [baseRef, setBaseRef] = useState(initial?.baseRef ?? "HEAD");
  const [confirmEmpty, setConfirmEmpty] = useState(false),
    [clean, setClean] = useState(false),
    [launching, setLaunching] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null),
    [cards, setCards] = useState<Preview["stages"]>([]),
    [pending, setPending] = useState(true),
    [resetNote, setResetNote] = useState("");
  // Destructive consent belongs to this target and this attempt only.
  useEffect(
    () => setClean(false),
    [project.id, pipeline, mode, topicIndex, name, baseRef],
  );
  const [settingsRefreshing, setSettingsRefreshing] = useState(false);
  const [settingsRefreshAttempt, setSettingsRefreshAttempt] = useState(0);
  // Fast discovery/preview promises may batch refreshing true → false into
  // one render. Publish the accepted catalog epoch to always prepare a fresh
  // token for the preserved selection (including skipped stages).
  const [appliedCatalogEpoch, setAppliedCatalogEpoch] = useState(0);
  const [settingsRefreshError, setSettingsRefreshError] = useState("");
  const [settingsPreviewFailure, setSettingsPreviewFailure] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const catalogKey = JSON.stringify([ownerKey, catalogAttempt]);
  const [catalogSettled, setCatalogSettled] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewSettled, setPreviewSettled] = useState("");
  const [previewError, setPreviewError] = useState("");
  const initialSettingsRevision = useRef(settingsRevision);
  const generation = useRef(0);
  const launchInFlight = useRef(false);
  const discoveryInFlight = useRef(true);
  // Catalog requests have their own epoch: previews must not invalidate them.
  const discoveryGeneration = useRef(0);
  const currentBranchRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    const epoch = ++discoveryGeneration.current;
    discoveryInFlight.current = true;
    setData(null);
    setPending(true);
    currentBranchRef.current = null;
    setError("");
    read("discover", scope).then(
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
        if (!owner && !d.topics.length) setMode("new");
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
  }, [ownerKey, catalogAttempt]);
  useEffect(() => {
    if (settingsRevision === initialSettingsRevision.current) return;
    let alive = true;
    const epoch = ++discoveryGeneration.current;
    discoveryInFlight.current = true;
    generation.current++;
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
        const fresh = await read("discover", scope);
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
        if (!owner && mode === "existing" && nextIndex < 0)
          throw new Error(
            "Выбранный топик отсутствует в обновлённом каталоге. Черновик сохранён.",
          );
        // Publish the new catalog even when selection validation or preview fails.
        setData(fresh);
        const missingProfile = missingProfileName(fresh, profile);
        if (missingPipeline || missingProfile) {
          currentBranchRef.current = fresh.currentBranch;
          setData(fresh);
          setTopicIndex(String(nextIndex));
          setCards([]);
          setError(
            missingProfile
              ? `Профиль «${missingProfile}» не найден. Выберите другой профиль перед запуском.`
              : "",
          );
          initialSettingsRevision.current = settingsRevision;
          setAppliedCatalogEpoch(epoch);
          setSettingsRefreshing(false);
          setPending(false);
          return;
        }
        readingPreview = true;
        const complete = await read("preview", {
          projectId: project.id,
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
        setData(fresh);
        setPipeline(nextPipeline);
        if (!owner && !data && mode === "existing" && !fresh.topics.length)
          setMode("new");
        setTopicIndex(String(nextIndex));
        setError("");
        initialSettingsRevision.current = settingsRevision;
        setAppliedCatalogEpoch(epoch);
        setSettingsRefreshing(false);
      } catch (e) {
        if (!alive || epoch !== discoveryGeneration.current) return;
        // A valid catalog with an invalid composition remains editable, but
        // cannot launch until an explicit retry or selection change succeeds.
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
  }, [ownerKey, settingsRevision, settingsRefreshAttempt]);
  const profileRequest =
    profile === "__auto__"
      ? { profile: "", profileMode: "auto" as const }
      : { profile };
  const compositionKey = JSON.stringify([
    ownerKey,
    pipeline,
    workflow,
    profile,
    skips,
    data?.currentBranch,
    data?.projectSettings?.version,
    settingsRevision,
    previewAttempt,
  ]);
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
        `Профиль «${missingProfile}» не найден. Выберите другой профиль перед запуском.`,
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
  const resetComposition = (fn: () => void) => {
    generation.current++;
    setPending(true);
    setPreview(null);
    setReadyKey("");
    setCards([]);
    setSkips([]);
    setResetNote("Выбор пропуска стадий сброшен для нового состава.");
    fn();
    if (settingsPreviewFailure) setSettingsRefreshAttempt((n) => n + 1);
  };
  const topic = owner
    ? { topic: owner.topic, branch: owner.branch, remote: false }
    : data?.topics[Number(topicIndex)];
  useEffect(() => {
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
  ]);
  const taskKey = !data
    ? null
    : JSON.stringify([
        ownerKey,
        mode,
        mode === "new" ? "draft" : topic?.branch,
        mode === "new" ? "" : topic?.topic,
      ]);
  const taskRequest =
    mode === "existing" && topic
      ? {
          projectId: project.id,
          ...(owner ? { context: contextRef(owner) } : {}),
          branch: topic.branch,
          topic: topic.topic,
        }
      : null;
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
        "Выбранный топик отсутствует в каталоге запуска. Черновики сохранены; обновите каталог.",
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
        "Черновик задачи в форме запуска сохранён. Текст из карточки его не заменил.",
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
  const taskReady = editor.ready && (!emptyReplacement || confirmEmpty);
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
  const resetSignature = JSON.stringify([
    suspended,
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
      const fresh = await read("discover", scope);
      if (!current()) return;
      let index = Number(topicIndex);
      let nextMode = mode;
      if (mode === "existing") {
        if (data && !topic)
          throw new Error(
            "Выбранный топик отсутствует. Выберите топик повторно.",
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
                ? "Выбранный топик неоднозначен в обновлённом каталоге."
                : "Выбранный топик отсутствует в обновлённом каталоге.",
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
        throw new Error("Goga не вернула доступных конвейеров.");
      const selected = owner
        ? { topic: owner.topic, branch: owner.branch }
        : fresh.topics[index];
      const nextKey = JSON.stringify([
        ownerKey,
        nextMode,
        nextMode === "new" ? "draft" : selected.branch,
        nextMode === "new" ? "" : selected.topic,
      ]);
      const previousTarget = drafts.tasks.get(nextKey);
      const document =
        nextMode === "existing"
          ? await read("readTopicTask", {
              projectId: project.id,
              ...(owner ? { context: contextRef(owner) } : {}),
              branch: selected.branch,
              topic: selected.topic,
            })
          : undefined;
      if (!current() || drafts.tasks.get(nextKey) !== previousTarget) return;
      const prepared = await read("preview", {
        projectId: project.id,
        ...(owner ? { context: contextRef(owner) } : {}),
        pipeline: nextPipeline,
        workflow: "auto",
        profile: "",
        skips: [],
      });
      if (!current() || drafts.tasks.get(nextKey) !== previousTarget) return;
      const nextCompositionKey = JSON.stringify([
        ownerKey,
        nextPipeline,
        "auto",
        "",
        [],
        fresh.currentBranch,
        fresh.projectSettings?.version,
        settingsRevision,
        previewAttempt,
      ]);
      // No await after this point: publish one prepared state, never a partial reset.
      generation.current++;
      preparedPreviewKey.current =
        nextCompositionKey !== compositionKey ? nextCompositionKey : null;
      drafts.tasks.set(nextKey, {
        text: document?.text ?? "",
        document,
        status: "ready",
        error: "",
      });
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
      setReadyKey(nextCompositionKey);
      setPreviewSettled(nextCompositionKey);
      setPreviewError("");
      setCards(prepared.stages);
      setPending(false);
      setResetNote("");
      setError("");
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
    (mode === "new" || (!!topic && topic.branch !== data?.currentBranch));
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
              "Текущая ветка изменилась. Проверьте параметры и подтвердите запуск повторно.",
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
  const ready =
    !suspended &&
    !blocked &&
    !settingsRefreshing &&
    !settingsRefreshError &&
    !!data &&
    !missingProfileName(data, profile) &&
    settingsRevision === initialSettingsRevision.current &&
    !!preview &&
    readyKey === compositionKey &&
    !pending &&
    preview.stages.length > 0;
  const validTopic = mode === "new" ? name.trim().length > 0 : !!topic;
  // Identity is monotonic even for A→B→A changes. Consent never attaches to
  // a later draft, preview or catalog that merely has equivalent visible text.
  const launchSignature = JSON.stringify([
    resetSignature,
    settingsRevision,
    suspended,
    ready,
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
  type LaunchIntent = {
    context: typeof launchSnapshot;
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
  }, [launchSnapshot]);
  const canLaunch =
    ready &&
    !!preview &&
    validTopic &&
    !!data &&
    !launching &&
    !resetting &&
    taskReady &&
    (!owner || !!task.trim());
  function requestLaunch(update: boolean) {
    if (
      !canLaunch ||
      !preview ||
      !data ||
      launchInFlight.current ||
      resetOperation.current
    )
      return;
    const intent: LaunchIntent = {
      context: launchSnapshot,
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
        workflow,
        ...profileRequest,
        skips: [...skips],
        previewToken: preview.token,
        task,
        ...(mode === "existing"
          ? { taskVersion: editor.draft!.document!.version }
          : {}),
        confirmEmptyTask: confirmEmpty,
        clean,
        update,
        topic:
          mode === "new"
            ? { mode: "new", name: name.trim(), baseRef }
            : { mode: "existing", branch: topic!.branch, topic: topic!.topic },
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
    setLaunching(true);
    setError("");
    try {
      const branch = await read(
        "checkoutBranch",
        intent.request.context ?? intent.request.projectId,
      );
      if (!mounted.current || launchContext.current !== intent.context) return;
      if (branch !== intent.request.expectedBranch) {
        updateBranch(branch);
        throw new Error(
          "Текущая ветка изменилась. Проверьте параметры и подтвердите запуск повторно.",
        );
      }
      const run = await window.goga.launch(intent.request);
      if (mounted.current) {
        const stale = launchContext.current !== intent.context;
        if (!stale) {
          editor.clear();
          if (drafts.forms.get(storageKey) === submittedForm)
            drafts.forms.delete(storageKey);
        }
        onLaunched(run, stale);
      }
    } catch (e) {
      if (mounted.current && launchContext.current === intent.context) {
        setError(message(e));
        try {
          const branch = await read(
            "checkoutBranch",
            intent.request.context ?? intent.request.projectId,
          );
          if (
            mounted.current &&
            launchContext.current === intent.context &&
            branch !== intent.request.expectedBranch
          )
            updateBranch(branch);
        } catch {}
      }
    } finally {
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
    !!data &&
    data.pipelines.length > 0 &&
    (mode === "new" || !!topic) &&
    (!editor.draft || editor.draft.status === "loading");
  const loadFailure =
    (!data && !catalogLoading ? error : "") ||
    (!settingsPreviewFailure ? settingsRefreshError : "") ||
    (editor.draft?.status === "error" ? editor.draft.error : "");
  const correctionError = settingsPreviewFailure ? settingsRefreshError : error;
  const formLoading =
    !suspended &&
    !loadFailure &&
    (catalogLoading ||
      settingsRefreshing ||
      (!settingsRefreshError &&
        settingsRevision !== initialSettingsRevision.current) ||
      (validComposition &&
        !settingsRefreshError &&
        (pending || previewSettled !== compositionKey)) ||
      (taskLoading &&
        !settingsPreviewFailure &&
        !(previewSettled === compositionKey && previewError)));
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
          <span className="eyebrow">GOGA / НОВЫЙ ЗАПУСК</span>
          <h2>Запустить конвейер</h2>
        </div>
        <button
          onClick={onCancel}
          disabled={launching || resetting}
          aria-label="Закрыть форму"
          className="quiet"
        >
          ✕
        </button>
      </div>
      <LoadingBoundary
        pending={formLoading}
        label="Загружаем параметры конвейера…"
        error={loadFailure}
        retryLabel={
          settingsRefreshError ? "Повторить обновление каталога" : undefined
        }
        onRetry={retryPreparation}
      >
        {!data ? (
          <div className="loading">
            {error
              ? "Не удалось получить каталог."
              : "Читаем каталог Goga… Это может занять время: команда использует Docker."}
          </div>
        ) : (
          <fieldset disabled={launching || suspended || settingsRefreshing}>
            <label>
              Конвейер
              <select
                value={pipeline}
                onChange={(e) =>
                  resetComposition(() => setPipeline(e.target.value))
                }
              >
                {pipeline && !data.pipelines.some((p) => p.id === pipeline) && (
                  <option value={pipeline}>
                    {pipeline} · не найден — выберите другой конвейер
                  </option>
                )}
                {!pipeline && <option value="">Выберите конвейер</option>}
                {data.pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                    {p.project ? " · проектный" : ""}
                  </option>
                ))}
              </select>
            </label>
            {pipeline && !data.pipelines.some((p) => p.id === pipeline) && (
              <p className="error" role="alert">
                Выбранный конвейер отсутствует в обновлённом каталоге. Выберите
                другой конвейер; черновик сохранён.
              </p>
            )}
            {!data.pipelines.length && (
              <p className="error" role="alert">
                Goga не вернула доступных конвейеров.
              </p>
            )}
            <p className="hint pipeline-description">
              {data.pipelines.find((p) => p.id === pipeline)?.description}
            </p>
            {!owner && (
              <div className="topic-block">
                <fieldset className="topic-mode">
                  <legend>Топик</legend>
                  <label>
                    <input
                      type="radio"
                      name={topicModeName}
                      checked={mode === "existing"}
                      onChange={() => {
                        setMode("existing");
                      }}
                    />
                    Существующий
                  </label>
                  <label>
                    <input
                      type="radio"
                      name={topicModeName}
                      checked={mode === "new"}
                      onChange={() => {
                        setMode("new");
                      }}
                    />
                    Создать новый
                  </label>
                </fieldset>
                {mode === "existing" ? (
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
                      >
                        Выбрано для запуска: {topic.topic} ↗
                      </button>
                    )}
                    {!topic?.topic && (
                      <p className="hint">Ветка без собственного топика.</p>
                    )}
                  </>
                ) : (
                  <div className="topic-new-row">
                    <label>
                      Имя нового топика
                      <input
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
                        >
                          Новый топик · посмотреть задачу ↗
                        </button>
                      )}
                    </label>
                    <label>
                      Исходная ветка
                      <select
                        value={baseRef}
                        onChange={(e) => {
                          setBaseRef(e.target.value);
                        }}
                      >
                        <option value="HEAD">
                          {data.currentBranch || "HEAD без ветки"} — текущая
                        </option>
                        {data.baseRef && (
                          <option value={data.baseRef}>
                            {data.baseRef} — базовая
                          </option>
                        )}
                        {data.branches
                          .filter((b) => b !== data.baseRef)
                          .map((b) => (
                            <option key={b} value={b}>
                              {b}
                              {b === data.currentBranch ? " — текущая" : ""}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                )}
                <div
                  className="topic-context"
                  aria-live="polite"
                  aria-label={`Текущая ветка checkout: ${data.currentBranch || "HEAD без ветки"}`}
                  title={`Текущая ветка checkout: ${data.currentBranch || "HEAD без ветки"}`}
                >
                  {mode === "new" ? (
                    <span>
                      Создадим «{name.trim() || "…"}» от{" "}
                      {baseRef === "HEAD"
                        ? data.currentBranch || "HEAD без ветки"
                        : baseRef}{" "}
                      и перейдём в ветку топика при запуске.
                    </span>
                  ) : topic ? (
                    switchRequired ? (
                      <span>
                        Переключение: {data.currentBranch || "HEAD без ветки"} →{" "}
                        {topic.branch}
                      </span>
                    ) : (
                      <span>Переключение не требуется</span>
                    )
                  ) : (
                    <span>Выберите топик</span>
                  )}
                </div>
                <p className="hint">
                  Один активный запуск на проект; другие проекты работают
                  независимо.
                </p>
              </div>
            )}
            {owner && (
              <p className="hint">
                Топик: {owner.topic}. Черновик закреплён за этой рабочей копией;
                другие топики работают независимо.
              </p>
            )}
            {blocked && (
              <p className="error" role="status">
                {typeof blocked === "string" ? blocked : "Запуск в этой рабочей копии временно недоступен."}
              </p>
            )}
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
                </svg>
                Что нужно сделать?
              </summary>
              <textarea
                aria-label="Что нужно сделать?"
                rows={5}
                value={task}
                disabled={!editor.ready}
                maxLength={100000}
                onChange={(e) => {
                  editor.edit(e.target.value);
                  setConfirmEmpty(false);
                }}
                placeholder={
                  mode === "new" ? "Опишите задачу для нового топика" : ""
                }
              />
              {editor.draft?.status === "loading" && (
                <p className="hint" role="status">
                  Читаем задачу выбранного топика…
                </p>
              )}
              {mode === "existing" && editor.ready && (
                <p className="hint">
                  {owner &&
                  editor.draft?.document?.catalogState ===
                    "missing-local-metadata"
                    ? "В этой копии данные топика ещё не созданы. Введите непустую задачу; она сохранится здесь только при запуске."
                    : !editor.draft?.document?.exists
                      ? "Файл задачи отсутствует."
                      : editor.draft.document.text === ""
                        ? "Файл задачи пуст."
                        : "Загружено полное содержимое задачи."}{" "}
                  {topic?.branch !== data.currentBranch &&
                    "Для другой ветки показана сохранённая в Git версия, без её незакоммиченных изменений."}
                </p>
              )}
              <p className="hint">
                {mode === "new"
                  ? "Задача будет записана в todo.md нового топика только при запуске."
                  : editor.dirty
                    ? "Есть несохранённые изменения. Они запишутся только кнопкой «Сохранить и запустить»."
                    : "Без изменений: запуск не переписывает todo.md."}{" "}
                Черновики сохраняются в памяти до закрытия приложения.
              </p>
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
                >
                  Перечитать задачу
                </button>
              )}
            </details>
            {editor.draft?.error && editor.draft.status !== "error" && (
              <p className="error" role="alert">
                Не удалось прочитать задачу: {editor.draft.error}
              </p>
            )}
            {owner && editor.ready && !task.trim() && (
              <p className="hint" role="status">
                Для запуска в этой копии нужна непустая задача.
              </p>
            )}
            {emptyReplacement && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={confirmEmpty}
                  onChange={(e) => setConfirmEmpty(e.target.checked)}
                />
                Подтверждаю сохранение пустой задачи
              </label>
            )}
            <div className="form-divider" />
            <div className="form-grid">
              <label>
                Рабочий процесс
                <select
                  value={workflow}
                  onChange={(e) =>
                    resetComposition(() => setWorkflow(e.target.value))
                  }
                >
                  <option value="auto">
                    Автоматически — по имени конвейера
                  </option>
                  <option value="none">Без рабочего процесса</option>
                  {data.workflows.map((w) => (
                    <option key={w} value={`file:${w}`}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Профиль
                <select
                  value={profile}
                  onChange={(e) =>
                    resetComposition(() => setProfile(e.target.value))
                  }
                >
                  {data.projectSettings ? (
                    <>
                      <option value="">
                        По умолчанию проекта —{" "}
                        {data.projectSettings.profile || "автоматически"}
                        {data.projectSettings.profile &&
                        !data.profiles.some(
                          (item) => item.name === data.projectSettings!.profile,
                        )
                          ? " · не найден"
                          : ""}
                      </option>
                      <option value="__auto__">
                        Автоматически — окружение / рабочий процесс
                      </option>
                    </>
                  ) : (
                    <option value="">
                      Автоматически — окружение / рабочий процесс
                    </option>
                  )}
                  {profile &&
                    profile !== "__auto__" &&
                    !data.profiles.some((p) => p.name === profile) && (
                      <option value={profile}>{profile} · не найден</option>
                    )}
                  {data.profiles.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name} ·{" "}
                      {p.source === "project" ? "проектный" : "личный"}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="applied">
              Рабочий процесс:{" "}
              <strong>
                {pending
                  ? "проверяем…"
                  : (preview?.workflow ?? "без рабочего процесса")}
              </strong>
              <span>
                Профиль:{" "}
                <strong>
                  {pending
                    ? "проверяем…"
                    : (preview?.profile ?? "не активирован")}
                </strong>
              </span>
            </p>
            <div className="section-heading compact">
              <h3>Стадии запуска</h3>
              <span className="hint" aria-live="polite">
                {pending
                  ? "Получаем состав у Goga…"
                  : `${preview?.stages.length ?? 0} выбрано`}
              </span>
            </div>
            <div className="stage-cards">
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
            <p className="hint">
              Снятая галочка пропускает стадию только в этом запуске.
              Определения и рабочий процесс не изменяются.
            </p>
            {resetNote && <p className="hint">{resetNote}</p>}
            {!pending && preview && !preview.stages.length && (
              <p role="alert" className="error">
                Нельзя запустить пустой набор стадий.
              </p>
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={clean}
                aria-describedby="clean-warning"
                onChange={(e) => setClean(e.target.checked)}
              />
              Начать с чистого состояния
            </label>
            <p id="clean-warning" className="hint">
              Сохранённое состояние этого конвейера будет удалено перед
              запуском. Очистка не исправляет ошибки самого конвейера.
            </p>
          </fieldset>
        )}
        {data && correctionError && !loadFailure && (
          <div role="alert" className="error">
            {correctionError}
          </div>
        )}
        {data && correctionError && !pending && (
          <button type="button" onClick={retryPreparation}>
            {settingsRefreshError
              ? "Повторить обновление каталога"
              : "Повторить загрузку"}
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
              : launchConfirmation.request.topic.branch
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
      <div className="form-actions" hidden={formLoading}>
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
        >
          Сбросить
        </button>
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
