import { t } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { useEffect, useState } from "react";
import { type DemoDirectory, useDemoValue } from "./directory";

export function DemoLaunchItem({
  store,
  scopeKey,
  enter,
}: {
  store: DemoDirectory;
  scopeKey: string;
  enter: (start: boolean) => void;
}) {
  useLocale();
  const showId = useDemoValue(store, () => store.showFor(scopeKey)?.showId);
  const busy = useDemoValue(store, () => store.starting.has(scopeKey));
  const [read, setRead] = useState<"loading" | "ready" | "failed">("loading"),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true;
    setRead("loading");
    store.refresh().then(
      () => {
        if (alive) setRead("ready");
      },
      () => {
        if (alive) setRead("failed");
      },
    );
    return () => {
      alive = false;
    };
  }, [store, scopeKey, retry]);
  return (
    <button
      type="button"
      role="menuitem"
      disabled={read === "loading" || busy}
      onClick={() =>
        read === "failed" ? setRetry((n) => n + 1) : enter(!showId)
      }
    >
      {read === "failed"
        ? t("general.checkDemonstrationAgain")
        : busy
          ? t("general.startingDemonstration")
          : read === "loading"
            ? t("general.demonstration")
            : showId
              ? t("general.openDemonstration")
              : t("general.startDemonstration")}
      <small>
        {read === "failed"
          ? t("general.couldNotGetTheDemonstrationStatus")
          : read === "loading"
            ? t("general.checkingDemonstrationStatus")
            : showId
              ? t("general.returnToDemonstrationPage")
              : t("general.openAPageForCollaboration")}
      </small>
    </button>
  );
}
