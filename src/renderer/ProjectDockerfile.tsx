import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useViewActive } from "./RetainedViews";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Project } from "../shared/types";
import type { TopicContextRef } from "../shared/worktrees";
import type { ProjectDockerfile as Metadata } from "../shared/project-documents";
import { contextRef } from "./topic-context";
import {
  documentScopeId,
  type DocumentSource,
  type SettingsDocuments,
} from "./settings-documents";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { SettingsDocument } from "./SettingsDocument";
export function ProjectDockerfile({
  project,
  owner,
  store,
}: {
  project: Project;
  owner?: TopicContextRef;
  store: SettingsDocuments;
}) {
  useLocale();
  const viewActive = useViewActive();
  const scope = owner ? contextRef(owner) : project.id,
    key = documentScopeId(scope);
  const active = useSyncExternalStore(store.subscribe, () =>
    store.dockerfile(scope),
  );
  const revision = useSyncExternalStore(store.subscribe, () =>
    store.projectRevision(scope),
  );
  // Retain the visible source during rechecks; settled/loadKey still gates writes.
  const [metadataState, setLatest] = useState<{
    revision: number;
    loadKey: string;
    key: string;
    value: Metadata;
  }>();
  const metadataLoaded = metadataState?.key === key;
  const latest = metadataLoaded ? metadataState.value : undefined;
  const [attempt, setAttempt] = useState(0);
  const loadKey = JSON.stringify([key, revision, attempt]);
  const [settled, setSettled] = useState("");
  const [error, setError] = useState(""),
    [pending, setPending] = useState(true);
  const read = useReadScope(loadKey);
  const sourceFor = (metadata: Metadata): DocumentSource => ({
    scope: "project",
    projectId: project.id,
    ...(owner ? { context: contextRef(owner) } : {}),
    target: { kind: "dockerfile", path: metadata.relativePath },
  });
  useEffect(() => {
    if (!viewActive) return;
    let current = true;
    setPending(true);
    setError("");
    read("resolveProjectDockerfile", scope).then(
      (metadata) => {
        if (!current) return;
        setLatest({ loadKey, revision, key, value: metadata });
        setSettled(loadKey);
        setPending(false);
        const old = store.dockerfile(scope),
          draft = old ? store.get(sourceFor(old)) : undefined;
        if (
          !old ||
          (!draft?.busy &&
            (!draft?.document || draft.text === draft.document.text))
        ) {
          if (
            old &&
            (old.relativePath !== metadata.relativePath ||
              old.configured !== metadata.configured)
          ) {
            store.discard(sourceFor(old));
            // A deliberate metadata change starts a fresh read even if only
            // configured changed and the exact document key stayed the same.
            void store.open(sourceFor(metadata));
          }
          store.selectDockerfile(scope, metadata);
        }
      },
      (error) => {
        if (current) {
          setPending(false);
          setSettled(loadKey);
          setError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [key, revision, attempt, viewActive]);
  const refreshing = pending || settled !== loadKey;
  const postSaveRefresh =
    viewActive &&
    refreshing &&
    !error &&
    metadataLoaded &&
    metadataState.loadKey === settled &&
    store.onlyDocumentSavesSince(scope, metadataState.revision);
  const stale =
    !!active &&
    !!latest &&
    (active.relativePath !== latest.relativePath ||
      active.configured !== latest.configured);
  const draft = useSyncExternalStore(store.subscribe, () =>
    active ? store.get(sourceFor(active)) : undefined,
  );
  return (
    <LoadingBoundary
      pending={refreshing && !metadataLoaded}
      label={msg("project.checkingDockerfilePath")}
    >
      {error && (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => setAttempt((value) => value + 1)}>{msg("project.retryLoading")}</button>
        </>
      )}
      {stale && (
        <div role="alert">
          <p>{msg("project.theDockerfileConfigurationChangedYourOldDraftWasKeptAnd")}</p>
          <button
            disabled={draft?.busy || refreshing || !!error}
            onClick={() => {
              if (draft?.busy || refreshing || error || !active || !latest)
                return;
              store.discard(sourceFor(active));
              store.selectDockerfile(scope, latest!);
              void store.open(sourceFor(latest!));
            }}
          >{msg("project.discardDraftAndOpenCurrentFile")}</button>
        </div>
      )}
      {active && (
        <SettingsDocument
          store={store}
          source={sourceFor(active)}
          path={active.relativePath}
          title={msg("project.image")}
          saveDisabled={refreshing || stale || !!error}
          postSaveRefresh={postSaveRefresh && !stale}
          description={
            active.configured
              ? msg("project.dockerfileForTheSelectedContextSaveToCreateAMissing")
              : msg("project.noDockerfilePathIsConfiguredOpenAnExistingFileOr")
          }
        />
      )}
    </LoadingBoundary>
  );
}
