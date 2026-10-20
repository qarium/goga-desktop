import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useDesktopNotifications } from "afm-notification-hook";
const w = window as any;
w.notificationEvidence = [];
w.recordNotification = (value: any) => {
  w.notificationEvidence.push({ ...value, time: Date.now() });
  console.log("NOTIFICATION_FIXTURE " + JSON.stringify(value));
};
function Test() {
  const [stages, setStages] = useState<any[]>([
    {
      id: "disposable-stage",
      name: "Goga notification test — no real pipeline",
      status: "running",
      updatedAt: "0",
    },
  ]);
  const state = useDesktopNotifications(
    stages,
    (id) => w.recordNotification({ kind: "focus-stage", id }),
    "Disposable notification test",
  );
  useEffect(() => {
    w.testState = () => ({
      enabled: state.enabled,
      permission: state.permission,
      hidden: document.hidden,
      visibility: document.visibilityState,
    });
    w.sendQuestion = () =>
      setStages([
        {
          ...stages[0],
          status: "awaiting_user_input",
          updatedAt: String(Date.now()),
        },
      ]);
    w.disableTest = state.disable;
  }, [state.enabled, state.permission, stages]);
  return (
    <p>
      Invisible disposable notification test; no Goga pipeline or user data.
    </p>
  );
}
createRoot(document.getElementById("root")!).render(<Test />);
