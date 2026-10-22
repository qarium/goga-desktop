import { useState } from "react";
import type { Project } from "../shared/types";
import type { TopicContextRef } from "../shared/worktrees";
import { ProjectDocuments } from "./ProjectDocuments";
import type { SettingsDocuments } from "./settings-documents";
export function ContextDocuments({
  project,
  owner,
  store,
}: {
  project: Project;
  owner: TopicContextRef;
  store: SettingsDocuments;
}) {
  const [tab, setTab] = useState("config");
  return (
    <section className="project-settings-panel">
      <div className="section-heading">
        <div>
          <h2>Файлы и конфигурация топика</h2>
          <p className="hint">
            {owner.topic} · изменения только в этой рабочей копии. Личные
            настройки остаются общими.
          </p>
        </div>
      </div>
      <nav className="section-tabs" aria-label="Файлы топика">
        {[
          ["config", "Конфигурация"],
          ["workflows", "Рабочие процессы"],
          ["pipelines", "Конвейеры"],
          ["image", "Образ"],
          ["profiles", "Профили"],
          ["tools", "Инструменты"],
        ].map(([id, title]) => (
          <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            {title}
          </button>
        ))}
      </nav>
      <ProjectDocuments
        owner={owner}
        project={project}
        tab={tab}
        store={store}
      />
    </section>
  );
}
