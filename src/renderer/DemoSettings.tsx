import { SearchablePicker } from "./SearchablePicker";
import { DemoOpenShows } from "./demonstrations/DemoOpenShows";
import { useEffect, useRef, useState } from "react";
import { Cable } from "lucide-react";
import { useViewActive } from "./RetainedViews";
import {
  DEMO_DEFAULT_PORT,
  DEMO_DEFAULT_ENGINE,
  type DemoEngine,
  type DemoState as Snapshot,
} from "../shared/demonstrations";
import "./DemoSettings.css";
const problem = (e: unknown) =>
  e instanceof Error
    ? e.message.replace(
        /^Error invoking remote method '[^']+': (?:Error: )?/,
        "",
      )
    : "Не удалось прочитать настройку порта.";
// These addresses are not credentials. Never put an admin URL, session id or
// request id in the address list (nor offer these addresses as panel links).
function AgentAddresses({ port }: { port: number }) {
  return (
    <dl className="demo-addresses" aria-label="Адреса для агента">
      <div>
        <dt>На этом компьютере</dt>
        <dd>
          <code data-testid="demo-local-address">http://127.0.0.1:{port}</code>
        </dd>
      </div>
      <div>
        <dt>Из Docker</dt>
        <dd>
          <code data-testid="demo-docker-address">
            http://host.docker.internal:{port}
          </code>
        </dd>
      </div>
    </dl>
  );
}

export function DemoSettings() {
  const active = useViewActive(),
    life = useRef<AbortController | null>(null),
    pending = useRef(false),
    generation = useRef(0);
  const [state, setState] = useState<Snapshot | null>(null),
    [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState(""),
    [notice, setNotice] = useState(""),
    [saving, setSaving] = useState<"engine" | "port" | null>(null);
  const busy = saving !== null;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    life.current = c;
    setErr("");
    setNotice("");
    setState(null);
    setSaving(null);
    pending.current = false;
    let timer: ReturnType<typeof setTimeout>;
    // A second panel can close the listener or change the saved number.
    // Preserve any unsubmitted edit and do not overwrite newer save results.
    const poll = async () => {
      if (!pending.current && !document.hidden) {
        const seq = ++generation.current;
        try {
          const s = await window.goga.demoState();
          if (!c.signal.aborted && seq === generation.current) setState(s);
        } catch (e) {
          if (!c.signal.aborted && seq === generation.current) {
            setState(null);
            setErr(problem(e));
          }
        }
      }
      if (!c.signal.aborted) timer = setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [active, attempt]);
  const raw = draft ?? String(state?.port ?? ""),
    n = Number(raw),
    valid =
      /^[0-9]{1,5}$/.test(raw) &&
      Number.isInteger(n) &&
      n >= 1024 &&
      n <= 65535;
  const locked = !!state?.access.owner;
  const save = async (engine?: DemoEngine) => {
    const signal = life.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      pending.current ||
      !state ||
      (engine
        ? engine === state.engine || !!state.settingsError
        : !valid || locked || (n === state.port && !state.settingsError))
    )
      return;
    pending.current = true;
    ++generation.current;
    setSaving(engine ? "engine" : "port");
    setErr("");
    setNotice("");
    try {
      await window.goga.demoExecute(
        engine ? { action: "engine", engine } : { action: "port", port: n },
      );
      const updated = await window.goga.demoState();
      if (!signal.aborted) {
        setState(updated);
        if (!engine) setDraft(null);
        setNotice(
          engine ? "Браузер для новых показов сохранён." : "Порт сохранён.",
        );
      }
    } catch (e) {
      if (!signal.aborted) {
        setErr(problem(e));
        try {
          const latest = await window.goga.demoState();
          if (!signal.aborted) setState(latest);
        } catch {
          /* Keep the original save error. */
        }
      }
    } finally {
      if (!signal.aborted) {
        setSaving(null);
        pending.current = false;
      }
    }
  };
  return (
    <section
      className="demo-settings"
      aria-label="Демонстрации"
      data-testid="demo-settings-section"
    >
      <div className="demo-settings-title">
        <Cable size={20} />
        <h3>Браузер и подключение агента</h3>
      </div>
      <p>
        Укажите порт заранее. Он общий для всех проектов и топиков на этом
        компьютере. Сохранение не открывает порт. Он откроется, когда вы начнёте
        первый показ.
      </p>
      {state?.settingsError && (
        <p className="error" role="alert">
          {state.settingsError}
        </p>
      )}
      {state && (
        <>
          <div className="demo-engine-edit">
            <SearchablePicker
              label="Браузер демонстрации"
              entries={[
                { value: "embedded", label: "Встроенный Chromium" },
                { value: "system", label: "Системный браузер" },
              ]}
              value={state.engine ?? DEMO_DEFAULT_ENGINE}
              onChange={(value) => {
                if (value === "embedded" || value === "system")
                  void save(value);
              }}
              disabled={busy || !!state.settingsError}
              placeholder="Выберите браузер"
              emptyLabel="Нет браузеров"
              listLabel="Браузеры демонстрации"
              searchLabel="Найти браузер"
              searchPlaceholder="Найти браузер"
            />
            <small>
              {(state.engine ?? DEMO_DEFAULT_ENGINE) === "embedded"
                ? "Входит в Goga. Отдельная установка браузера не нужна."
                : "Используется совместимый браузер, установленный на компьютере."}{" "}
              Выбор применяется только к новым показам.
            </small>
          </div>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor="demo-agent-port">Порт агента</label>
            <div className="demo-port-edit">
              <input
                id="demo-agent-port"
                data-testid="demo-port"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="demo-port-hint"
                aria-invalid={!valid}
                disabled={busy || locked}
                value={raw}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setErr("");
                  setNotice("");
                }}
              />
              <button
                type="submit"
                className="primary"
                data-testid="demo-port-save"
                disabled={
                  busy ||
                  locked ||
                  !valid ||
                  (n === state.port && !state.settingsError)
                }
              >
                {saving === "port" ? "Сохраняем…" : "Сохранить"}
              </button>
            </div>
            <small id="demo-port-hint" data-error={!valid}>
              {locked
                ? "Чтобы изменить порт, закройте показ «" +
                  (state.shows.find((c) => c.showId === state.access.owner)
                    ?.label ?? state.access.owner) +
                  "», к которому он привязан."
                : !valid
                  ? "Введите целое число от 1024 до 65535."
                  : "От 1024 до 65535. По умолчанию: " +
                    DEMO_DEFAULT_PORT +
                    "."}
            </small>
          </form>
          <DemoOpenShows
            shows={state.shows}
            stop={async (showId) => {
              const signal = life.current?.signal;
              if (!signal || signal.aborted) throw Error("Настройки закрыты.");
              await window.goga.demoExecute({ action: "stop", showId });
              const seq = ++generation.current;
              const latest = await window.goga.demoState();
              if (!signal.aborted && seq === generation.current)
                setState(latest);
            }}
          />
          <h4>Адреса для агента</h4>
          <AgentAddresses port={state.port} />
          <p className="demo-settings-note">
            Это адреса для программы, управляющей показом, а не для просмотра
            панели в браузере. Первый клиент, который подключится к этому порту,
            автоматически получит управление привязанным показом. Отдельного
            запроса и ключа нет. Запускайте только доверенных агентов.
          </p>
        </>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {!state && !err && <p role="status">Загружаем настройку…</p>}
      {!state && err && (
        <button onClick={() => setAttempt((n) => n + 1)}>Повторить</button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
