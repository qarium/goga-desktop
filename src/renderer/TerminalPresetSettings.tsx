import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Minus,
  Pencil,
  Plus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import {
  parseTerminalPresetDraft,
  type TerminalPresetDocument,
  type TerminalPresetDraft,
  type TerminalPresetMenuItem,
  type TerminalPresetSummary,
} from "../shared/terminal-presets";
import { useViewActive } from "./RetainedViews";
import { preparationErrorMessage } from "./preparation-error";
import "./TerminalPresetSettings.css";

interface Row {
  uid: number;
  key: string;
  value: string;
}
interface Editor {
  id?: string;
  revision?: string;
  name: string;
  command: string;
  rows: Row[];
}
const fresh = (): Editor => ({ name: "", command: "", rows: [] });
export function TerminalPresetSettings() {
  const api = window.goga.terminalPresets,
    active = useViewActive();
  const [items, setItems] = useState<TerminalPresetSummary[]>([]),
    [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Editor | null>(null),
    [open, setOpen] = useState(false),
    [shown, setShown] = useState<Set<number>>(new Set());
  const [remove, setRemove] = useState<TerminalPresetMenuItem | null>(null);
  const [busy, setBusy] = useState(false),
    [msg, setMsg] = useState(""),
    [error, setError] = useState("");
  const rowId = useRef(0),
    alive = useRef(true),
    flight = useRef(false),
    reading = useRef(0);
  const field = useRef<HTMLInputElement>(null),
    isActive = useRef(active);
  isActive.current = active;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      reading.current++;
    };
  }, []);
  useEffect(() => {
    if (!active) {
      setShown(new Set());
      setMsg("");
      return;
    }
    if (!api) return;
    const token = ++reading.current;
    let here = true;
    setListError("");
    api({ kind: "list" }).then(
      (next) => {
        if (here && reading.current === token) {
          setItems(next);
          setLoaded(true);
        }
      },
      (e) => {
        if (here && reading.current === token)
          setListError(preparationErrorMessage(e));
      },
    );
    return () => {
      here = false;
    };
  }, [active, api, attempt]);
  useEffect(() => {
    if (draft) field.current?.focus();
  }, [draft?.id, !!draft]);
  const reset = () => {
    setDraft(null);
    setRemove(null);
    setShown(new Set());
    setOpen(false);
    setError("");
  };
  async function run(f: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setMsg("");
    setError("");
    try {
      await f();
    } catch (e) {
      if (alive.current) setError(preparationErrorMessage(e));
    } finally {
      flight.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function edit(id: string) {
    if (!api) return;
    void run(async () => {
      const doc = await api({ kind: "read", id });
      if (!alive.current || !isActive.current) return;
      reset();
      setDraft({
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        command: doc.command,
        rows: doc.env.map((r) => ({ ...r, uid: ++rowId.current })),
      });
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !api || busy) return;
    let clean: TerminalPresetDraft;
    try {
      clean = parseTerminalPresetDraft({
        name: draft.name.trim(),
        command: draft.command,
        env: draft.rows.map(({ key, value }) => ({ key, value })),
      });
      if (
        items.some(
          (v) =>
            v.id !== draft.id &&
            v.name.toLowerCase() === clean.name.toLowerCase(),
        )
      )
        throw Error("Пресет с таким названием уже есть.");
    } catch (e) {
      setError(preparationErrorMessage(e));
      if (draft.rows.length) setOpen(true);
      return;
    }
    const body = clean;
    await run(async () => {
      const doc: TerminalPresetDocument = await api(
        draft.id && draft.revision
          ? {
              kind: "save",
              id: draft.id,
              revision: draft.revision,
              draft: body,
            }
          : { kind: "save", draft: body },
      );
      if (!alive.current) return;
      ++reading.current;
      const summary = {
        id: doc.id,
        revision: doc.revision,
        name: doc.name,
        command: doc.command,
        envCount: doc.env.length,
      };
      setItems((list) =>
        list.some((i) => i.id === doc.id)
          ? list.map((i) => (i.id === doc.id ? summary : i))
          : [...list, summary],
      );
      setLoaded(true);
      reset();
      setMsg("Сохранено. Пресет доступен в меню терминала.");
      setAttempt((v) => v + 1);
    });
  }
  function confirmDelete() {
    if (!api || !remove) return;
    const target = remove;
    void run(async () => {
      await api({ kind: "remove", id: target.id, revision: target.revision });
      if (!alive.current) return;
      ++reading.current;
      setItems((v) => v.filter((i) => i.id !== target.id));
      reset();
      setMsg("Пресет удалён.");
      setAttempt((v) => v + 1);
    });
  }
  function rowChanged(uid: number, key: "key" | "value", v: string) {
    setDraft(
      (cur) =>
        cur && {
          ...cur,
          rows: cur.rows.map((r) => (r.uid === uid ? { ...r, [key]: v } : r)),
        },
    );
  }
  const locked = busy || !!remove || !!draft;
  return (
    <section className="terminal-presets" aria-label="Пресеты терминала">
      <div className="terminal-presets-head">
        <div>
          <h3>Пресеты вкладок</h3>
          <p>Личные команды для всех проектов и топиков.</p>
        </div>
        <button
          type="button"
          className="primary"
          disabled={!api || locked || !loaded}
          onClick={() => {
            reset();
            setMsg("");
            setDraft(fresh());
          }}
        >
          <Plus size={16} />
          Новый пресет
        </button>
      </div>
      {!api ? (
        <p role="alert">Настройки пресетов недоступны.</p>
      ) : listError ? (
        <div role="alert">
          {listError}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => setAttempt((v) => v + 1)}
          >
            Повторить загрузку
          </button>
        </div>
      ) : !loaded ? (
        <p role="status">Загружаем пресеты…</p>
      ) : null}
      {loaded && !listError && !items.length && <p>Пресетов пока нет.</p>}
      {items.length > 0 && (
        <ul className="terminal-presets-list">
          {items.map((p) => (
            <li key={p.id}>
              <SquareTerminal size={17} aria-hidden="true" />
              <div className="terminal-preset-summary">
                <strong>{p.name}</strong>
                <code>{p.command}</code>
                <small>Переменных: {p.envCount}</small>
              </div>
              <button
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={"Редактировать " + p.name}
                title="Редактировать"
                onClick={() => edit(p.id)}
              >
                <Pencil size={16} />
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={"Удалить " + p.name}
                title="Удалить"
                onClick={() => {
                  reset();
                  setMsg("");
                  setRemove(p);
                }}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {draft && (
        <form
          className="terminal-preset-editor"
          onSubmit={save}
          autoComplete="off"
        >
          <h3>{draft.id ? "Редактирование пресета" : "Новый пресет"}</h3>
          <div className="terminal-preset-fields">
            <label>
              Название вкладки
              <input
                ref={field}
                disabled={busy}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Например, Dev-сервер"
              />
            </label>
            <label>
              Команда
              <input
                disabled={busy}
                value={draft.command}
                onChange={(e) =>
                  setDraft({ ...draft, command: e.target.value })
                }
                placeholder="npm run dev"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="terminal-preset-env">
            <button
              className="terminal-preset-expander"
              type="button"
              aria-expanded={open}
              disabled={busy}
              onClick={() => {
                setOpen(!open);
                setShown(new Set());
              }}
            >
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              Переменные окружения{" "}
              <small>· {draft.rows.length || "необязательно"}</small>
            </button>
            {open && (
              <>
                <p>
                  Только для этой вкладки и запущенных в ней команд. Значения
                  передаются без подстановки.
                </p>
                {draft.rows.map((r, i) => (
                  <div key={r.uid} className="terminal-preset-env-row">
                    <label>
                      Имя
                      <input
                        aria-label={`Имя переменной ${i + 1}`}
                        value={r.key}
                        disabled={busy}
                        onChange={(e) =>
                          rowChanged(r.uid, "key", e.target.value)
                        }
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder="PORT"
                      />
                    </label>
                    <label>
                      Значение
                      <input
                        aria-label={`Значение ${i + 1}`}
                        value={r.value}
                        disabled={busy}
                        type={shown.has(r.uid) ? "text" : "password"}
                        onChange={(e) =>
                          rowChanged(r.uid, "value", e.target.value)
                        }
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </label>
                    <div className="terminal-preset-actions">
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={
                          (shown.has(r.uid) ? "Скрыть" : "Показать") +
                          " значение " +
                          (i + 1)
                        }
                        aria-pressed={shown.has(r.uid)}
                        disabled={busy}
                        onClick={() =>
                          setShown((v) => {
                            const next = new Set(v);
                            if (!next.delete(r.uid)) next.add(r.uid);
                            return next;
                          })
                        }
                      >
                        {shown.has(r.uid) ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        disabled={busy}
                        aria-label={`Удалить переменную ${i + 1}`}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            rows: draft.rows.filter((v) => v.uid !== r.uid),
                          })
                        }
                      >
                        <Minus size={16} />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  className="quiet"
                  disabled={busy || draft.rows.length >= 256}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      rows: [
                        ...draft.rows,
                        { uid: ++rowId.current, key: "", value: "" },
                      ],
                    })
                  }
                >
                  <Plus size={15} />
                  Добавить переменную
                </button>
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="terminal-preset-error">
              {error}
            </p>
          )}
          <div className="terminal-preset-actions">
            <button type="submit" className="primary" disabled={busy}>
              Сохранить
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={reset}
            >
              Отмена
            </button>
          </div>
        </form>
      )}
      {remove && (
        <section
          className="terminal-preset-editor"
          aria-label="Подтверждение удаления пресета"
        >
          <h3>Удалить пресет «{remove.name}»?</h3>
          <p>Уже открытые вкладки останутся.</p>
          <div className="terminal-preset-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={confirmDelete}
            >
              Удалить пресет
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={reset}
            >
              Отмена
            </button>
          </div>
        </section>
      )}
      {!draft && error && (
        <p className="terminal-preset-error" role="alert">
          {error}
        </p>
      )}
      {msg && <p role="status">{msg}</p>}
    </section>
  );
}
