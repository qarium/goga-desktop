import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
    : t("general.couldNotReadThePortSetting");
// These addresses are not credentials. Never put an admin URL, session id or
// request id in the address list (nor offer these addresses as panel links).
function AgentAddresses({ port }: { port: number }) {
  useLocale();
  return (
    <dl className="demo-addresses" aria-label={t("general.agentConnectionAddresses")}>
      <div>
        <dt>{t("general.onThisComputer")}</dt>
        <dd>
          <code data-testid="demo-local-address">http://127.0.0.1:{port}</code>
        </dd>
      </div>
      <div>
        <dt>{t("general.fromDocker")}</dt>
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
  useLocale();
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
          engine ? t("general.browserPreferenceSavedForNewDemonstrations") : t("general.portSaved"),
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
      aria-label={t("general.demonstrations")}
      data-testid="demo-settings-section"
    >
      <div className="demo-settings-title">
        <Cable size={20} />
        <h3>{t("general.browserAndAgentConnection")}</h3>
      </div>
      <p>{t("general.setThePortInAdvanceAllProjectsAndTopics")}</p>
      {state?.settingsError && (
        <p className="error" role="alert">
          {state.settingsError}
        </p>
      )}
      {state && (
        <>
          <div className="demo-engine-edit">
            <SearchablePicker
              label={t("general.demonstrationBrowser")}
              entries={[
                { value: "embedded", label: t("general.bundledChromium") },
                { value: "system", label: t("general.systemBrowser") },
              ]}
              value={state.engine ?? DEMO_DEFAULT_ENGINE}
              onChange={(value) => {
                if (value === "embedded" || value === "system")
                  void save(value);
              }}
              disabled={busy || !!state.settingsError}
              placeholder={t("general.selectABrowser")}
              emptyLabel={t("general.noBrowsers")}
              listLabel={t("general.demonstrationBrowsers")}
              searchLabel={t("general.findABrowser")}
              searchPlaceholder={t("general.findABrowser")}
            />
            <small>
              {(state.engine ?? DEMO_DEFAULT_ENGINE) === "embedded"
                ? t("general.includedWithGogaNoSeparateBrowserInstallationRequired")
                : t("general.usesACompatibleBrowserInstalledOnThisComputer")}{" "}{t("general.appliesOnlyToNewDemonstrations")}</small>
          </div>
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label htmlFor="demo-agent-port">{t("general.agentPort")}</label>
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
                {saving === "port" ? t("general.saving") : t("general.save")}
              </button>
            </div>
            <small id="demo-port-hint" data-error={!valid}>
              {locked
                ? t("general.portOwnerHint", {name: state.shows.find(c => c.showId === state.access.owner)?.label ?? state.access.owner ?? ""})
                : !valid
                  ? t("general.enterAWholeNumberBetween1024And65535")
                  : t("general.portRange", {port: DEMO_DEFAULT_PORT})}
            </small>
          </form>
          <DemoOpenShows
            shows={state.shows}
            stop={async (showId) => {
              const signal = life.current?.signal;
              if (!signal || signal.aborted) throw Error(t("general.settingsClosed"));
              await window.goga.demoExecute({ action: "stop", showId });
              const seq = ++generation.current;
              const latest = await window.goga.demoState();
              if (!signal.aborted && seq === generation.current)
                setState(latest);
            }}
          />
          <h4>{t("general.agentConnectionAddresses")}</h4>
          <AgentAddresses port={state.port} />
          <p className="demo-settings-note">{t("general.theseAddressesAreForTheAgentControllingTheDemonstration")}</p>
        </>
      )}
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      {!state && !err && <p role="status">{t("general.loadingSetting")}</p>}
      {!state && err && (
        <button onClick={() => setAttempt((n) => n + 1)}>{t("general.retry")}</button>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
