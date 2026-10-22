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
  const scope = owner ? contextRef(owner) : project.id,
    key = documentScopeId(scope);
  const active = useSyncExternalStore(store.subscribe, () =>
    store.dockerfile(scope),
  );
  const revision = useSyncExternalStore(store.subscribe, () =>
    store.projectRevision(scope),
  );
  const [latest, setLatest] = useState<Metadata>();
  const [error, setError] = useState(""),
    [pending, setPending] = useState(true);
  const read = useReadScope(JSON.stringify([key, revision]));
  const sourceFor = (metadata: Metadata): DocumentSource => ({
    scope: "project",
    projectId: project.id,
    ...(owner ? { context: contextRef(owner) } : {}),
    target: { kind: "dockerfile", path: metadata.relativePath },
  });
  useEffect(() => {
    let current = true;
    setPending(true);
    setError("");
    setLatest(undefined);
    read("resolveProjectDockerfile", scope).then(
      (metadata) => {
        if (!current) return;
        setLatest(metadata);
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
          )
            store.discard(sourceFor(old));
          store.selectDockerfile(scope, metadata);
        }
      },
      (error) => {
        if (current) {
          setPending(false);
          setError(error instanceof Error ? error.message : String(error));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [key, revision]);
  const stale =
    !!active &&
    !!latest &&
    (active.relativePath !== latest.relativePath ||
      active.configured !== latest.configured);
  const draft = useSyncExternalStore(store.subscribe, () =>
    active ? store.get(sourceFor(active)) : undefined,
  );
  return (
    <>
      {pending && <p role="status">Проверяем путь Dockerfile…</p>}
      {error && <p role="alert">{error}</p>}
      {stale && (
        <div role="alert">
          <p>
            Конфигурация Dockerfile изменилась. Старый черновик сохранён и не
            будет перенаправлен в другой файл.
          </p>
          <button
            disabled={draft?.busy}
            onClick={() => {
              store.discard(sourceFor(active!));
              store.selectDockerfile(scope, latest!);
            }}
          >
            Отбросить черновик и открыть актуальный файл
          </button>
        </div>
      )}
      {active && (
        <SettingsDocument
          store={store}
          source={sourceFor(active)}
          path={active.relativePath}
          title="Образ"
          saveDisabled={pending || stale || !!error}
          description={
            active.configured
              ? "Dockerfile выбранного контекста. Отсутствующий файл можно создать сохранением. Docker и сборка не запускаются."
              : "Путь Dockerfile не настроен. Можно открыть существующий или создать .goga/Dockerfile при сохранении. Затем файл необходимо подключить вручную в конфигурации Goga. Конфигурация здесь не изменяется."
          }
        />
      )}
    </>
  );
}
