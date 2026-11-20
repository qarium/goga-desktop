import { HintButton } from "./ActionHint";
import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
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
        throw Error(t("general.aPresetWithThisNameAlreadyExists"));
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
      setMsg(t("general.savedThePresetIsAvailableInTheTerminalMenu"));
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
      setMsg(t("general.presetDeleted"));
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
    <section className="terminal-presets" aria-label={t("general.terminalPresets")}>
      <div className="terminal-presets-head">
        <div>
          <h3>{t("general.tabPresets")}</h3>
          <p>{t("general.personalCommandsForAllProjectsAndTopics")}</p>
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
          <Plus size={16} />{t("general.newPreset")}</button>
      </div>
      {!api ? (
        <p role="alert">{t("general.presetSettingsAreUnavailable")}</p>
      ) : listError ? (
        <div role="alert">
          {listError}{" "}
          <button
            type="button"
            disabled={busy}
            onClick={() => setAttempt((v) => v + 1)}
          >{t("general.retryLoading")}</button>
        </div>
      ) : !loaded ? (
        <p role="status">{t("general.loadingPresets")}</p>
      ) : null}
      {loaded && !listError && !items.length && <p>{t("general.noPresetsYet")}</p>}
      {items.length > 0 && (
        <ul className="terminal-presets-list">
          {items.map((p) => (
            <li key={p.id}>
              <SquareTerminal size={17} aria-hidden="true" />
              <div className="terminal-preset-summary">
                <strong>{p.name}</strong>
                <code>{p.command}</code>
                <small>{t("general.variables")} {p.envCount}</small>
              </div>
              <HintButton
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={t("general.editPresetNamed",{name:p.name})}
                hint={t("general.edit2")}
                onClick={() => edit(p.id)}
              >
                <Pencil size={16} />
              </HintButton>
              <HintButton
                type="button"
                className="icon-button"
                disabled={locked}
                aria-label={t("general.deletePresetNamed",{name:p.name})}
                hint={t("general.delete")}
                onClick={() => {
                  reset();
                  setMsg("");
                  setRemove(p);
                }}
              >
                <Trash2 size={16} />
              </HintButton>
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
          <h3>{draft.id ? t("general.editPreset") : t("general.newPreset")}</h3>
          <div className="terminal-preset-fields">
            <label>{t("general.tabName")}<input
                ref={field}
                disabled={busy}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("general.eGDevServer")}
              />
            </label>
            <label>{t("general.command")}<input
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
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}{t("general.environmentVariables")}{" "}
              <small>· {draft.rows.length || t("general.optional")}</small>
            </button>
            {open && (
              <>
                <p>{t("general.appliesOnlyToThisTabAndItsCommandsValues")}</p>
                {draft.rows.map((r, i) => (
                  <div key={r.uid} className="terminal-preset-env-row">
                    <label>{t("general.name")}<input
                        aria-label={t("general.variableName", { value1: i + 1 })}
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
                    <label>{t("general.value")}<input
                        aria-label={t("general.value2", { value1: i + 1 })}
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
                          t(shown.has(r.uid) ? "general.hideValueAt" : "general.showValueAt",{position:i+1})
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
                        aria-label={t("general.deleteVariable", { value1: i + 1 })}
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
                  <Plus size={15} />{t("general.addVariable")}</button>
              </>
            )}
          </div>
          {error && (
            <p role="alert" className="terminal-preset-error">
              {error}
            </p>
          )}
          <div className="terminal-preset-actions">
            <button type="submit" className="primary" disabled={busy}>{t("general.save")}</button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={reset}
            >{t("general.cancel")}</button>
          </div>
        </form>
      )}
      {remove && (
        <section
          className="terminal-preset-editor"
          aria-label={t("general.confirmPresetDeletion")}
        >
          <h3>{t("general.deletePresetConfirm", {name: remove.name})}</h3>
          <p>{t("general.existingTabsWillStayOpen")}</p>
          <div className="terminal-preset-actions">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={confirmDelete}
            >{t("general.deletePreset2")}</button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={reset}
            >{t("general.cancel")}</button>
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
