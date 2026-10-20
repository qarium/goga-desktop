import { memo, useLayoutEffect, useRef } from "react";
import type { Run } from "../shared/types";
import "./RunOutput.css";

export function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 7 4 5-4 5m8 0h6" />
    </svg>
  );
}

export function dashboardReady(run: Run) {
  return (
    !run.recovery &&
    run.kind !== "build" &&
    run.status === "running" &&
    !!run.url &&
    (run.dashboardOpened === true || run.dashboardOpened === undefined)
  );
}

// Output is already bounded, sanitized and throttled by the host. Keep it as
// one text node: never interpret HTML, terminal commands, links or ANSI markup.
const OutputText = memo(function OutputText({
  text,
  live,
}: {
  text: string;
  live: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text]);
  return (
    <div
      className="run-output-viewport"
      ref={viewport}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
      }}
    >
      <pre
        className="run-output-text"
        aria-label="Строки вывода запуска"
        tabIndex={0}
      >
        {text}
      </pre>
      {!text && (
        <p className="run-output-empty">
          {live
            ? "Новых сообщений пока нет. Вывод появится здесь по мере поступления."
            : "Сохранённых сообщений нет."}
        </p>
      )}
    </div>
  );
});

export function RunOutput({
  run,
  viewError,
}: {
  run: Run;
  viewError?: string;
}) {
  const isBuild = run.kind === "build";
  const unverified = run.recovery === "unverified";
  const confirmed = run.recovery === "confirmed";
  const active =
    !unverified && (run.status === "starting" || run.status === "running");
  const ready = dashboardReady(run);
  const failure = viewError || run.error;
  const title = unverified
    ? "Состояние процесса не подтверждено после перезапуска"
    : viewError
      ? "Панель конвейера недоступна"
      : run.status === "failed" || (active && !!failure)
        ? "Не удалось запустить"
        : run.status === "exited"
          ? "Процесс завершён"
          : run.status === "stopped"
            ? "Запуск остановлен"
            : confirmed
              ? "Процесс подтверждён после перезапуска"
              : isBuild
                ? "Сборка выполняется"
                : "Готовим запуск";
  return (
    <section className="run-output-page" aria-label="Журнал вывода">
      {run.syncPending && (
        <p className="run-output-note" role="status">
          Синхронизация коммитов ожидает выполнения. Это отдельное состояние и
          не меняет результат запуска.
        </p>
      )}
      {run.persistenceError && (
        <p className="error" role="alert">
          История запуска не сохранена полностью: {run.persistenceError}. Не
          закрывайте приложение до проверки сохранности истории.
        </p>
      )}
      {(!ready || failure) && (
        <div className="run-output-hero">
          <div
            className={`run-output-symbol ${failure ? "has-error" : ""}`}
            aria-hidden="true"
          >
            {active && !confirmed && !failure ? (
              <svg
                className="run-output-spinner"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M21 12a9 9 0 1 1-9-9" />
              </svg>
            ) : (
              <TerminalIcon />
            )}
          </div>
          <div>
            <h2>{title}</h2>
            <p className={failure ? "error" : ""}>
              {unverified
                ? "Последний вывод сохранён. Desktop не подтверждает завершение процесса, не останавливает неизвестный процесс и не запускает повтор автоматически. Рабочая копия остаётся занятой до проверки."
                : failure ||
                  (confirmed
                    ? "Исходный вывод и Dashboard не восстановлены. Ниже — сохранённый журнал. Процесс не перезапускался."
                    : active
                      ? `${run.update ? "Запуск с обновлением образа." : "Обычный запуск."} Вывод появляется ниже по мере поступления.`
                      : "Вывод этого запуска сохранён ниже.")}
            </p>
            {active && !confirmed && !failure && !ready && !isBuild && (
              <p className="run-output-budget">
                До открытия Dashboard — не более{" "}
                {(run.startupTimeoutMs ?? 600_000) / 60_000} мин
              </p>
            )}
          </div>
        </div>
      )}
      <section
        id="run-output-journal"
        className="run-output-journal"
        aria-label="Вывод запуска"
      >
        <header className="run-output-header">
          <TerminalIcon />
          <h3>Вывод</h3>
        </header>
        <OutputText text={run.output?.text ?? ""} live={active && !confirmed} />
        <footer className="run-output-footer">
          <span>
            {active && !confirmed ? "Вывод обновляется" : "Вывод сохранён"}
          </span>
          <span>Журнал этой вкладки</span>
        </footer>
      </section>
      {run.output?.truncated && (
        <p className="run-output-note">
          Часть вывода удалена или скрыта из-за ограничений журнала. Показан
          последний доступный вывод.
        </p>
      )}
      <p className="run-output-note">
        Известные секреты скрываются. Неизвестные секреты могут остаться в
        выводе — проверьте его перед передачей.
      </p>
      <p className="run-output-hint">
        {confirmed
          ? "Сохранённый журнал не является текущим потоком вывода. Автоматического повторного запуска нет."
          : isBuild
            ? "Вывод сборки доступен во время выполнения и после завершения. Автоматического повторного запуска нет."
            : ready && !failure
              ? "Повторный клик по «Работает» вернёт Dashboard. Конвейер не останавливается."
              : active && !failure
                ? "Dashboard откроется автоматически, когда будет готов. Отсутствие новых строк само по себе не означает ошибку."
                : "Автоматического повторного запуска нет."}
      </p>
    </section>
  );
}
