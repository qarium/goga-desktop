import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useState } from "react";
import type { Project } from "../shared/types";
import type { TopicContextRef } from "../shared/worktrees";
import { SettingsTabs } from "./SettingsDocument";
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
  useLocale();
  const [tab, setTab] = useState("config");
  return (
    <section className="project-settings-panel">
      <div className="section-heading">
        <div>
          <h2>{msg("project.topicFilesAndConfiguration")}</h2>
          <p className="hint">
            {owner.topic}{msg("project.changesApplyOnlyToThisWorkingCopyPersonalSettingsRemain")}</p>
        </div>
      </div>
      <SettingsTabs workspace current={tab} onChange={setTab} label={msg("project.topicFiles")}
        tabs={[
          ["config", msg("project.configuration")],
          ["workflows", msg("project.workflows")],
          ["pipelines", msg("project.pipelines")],
          ["image", msg("project.image")],
          ["profiles", msg("project.profiles")],
          ["tools", msg("project.tools")],
        ]}
      />
      <ProjectDocuments
        owner={owner}
        project={project}
        tab={tab}
        store={store}
      />
    </section>
  );
}
