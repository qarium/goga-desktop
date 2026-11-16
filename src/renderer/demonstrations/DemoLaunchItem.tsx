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
        ? "Проверить демонстрацию снова"
        : busy
          ? "Запускаем демонстрацию…"
          : read === "loading"
            ? "Демонстрация"
            : showId
              ? "Открыть демонстрацию"
              : "Начать демонстрацию"}
      <small>
        {read === "failed"
          ? "Не удалось получить состояние показа"
          : read === "loading"
            ? "Проверяем состояние показа…"
            : showId
              ? "Вернуться к странице показа"
              : "Открыть страницу для совместной работы"}
      </small>
    </button>
  );
}
