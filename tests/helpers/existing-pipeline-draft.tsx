import React, { useRef, type ComponentProps } from "react";
import { LaunchForm } from "../../src/renderer/LaunchForm";
import {
  createDraftStore,
  type DraftStore,
} from "../../src/renderer/task-drafts";

/** Task-editor scenarios explicitly restore an existing-topic selection.
 * An unseeded primary form now correctly defaults to no topic. */
export function existingPipelineDraft(
  projectId: string,
  store: DraftStore = createDraftStore(),
) {
  if (!store.forms.has(projectId))
    store.forms.set(projectId, {
      mode: "existing",
      branch: "",
      name: "",
      baseRef: "HEAD",
    });
  return store;
}

/** Real form with an explicitly restored topic choice for topic-only scenarios. */
export function ExistingTopicLaunchForm(
  props: ComponentProps<typeof LaunchForm>,
) {
  const local = useRef(createDraftStore());
  const drafts = existingPipelineDraft(
    props.project.id,
    props.draftStore ?? local.current,
  );
  return <LaunchForm {...props} draftStore={drafts} />;
}
