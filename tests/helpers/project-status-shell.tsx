import React from "react";
import { ProjectDocumentStatusOutlet } from "../../src/renderer/ProjectDocumentStatus";

export function ProjectStatusShell({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  return (
    <ProjectDocumentStatusOutlet.Provider value={slot}>
      <div data-testid="context-bar-file-status" ref={setSlot} />
      {children}
    </ProjectDocumentStatusOutlet.Provider>
  );
}
