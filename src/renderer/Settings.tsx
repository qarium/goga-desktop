import { t } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { InterfaceLanguageSettings } from "./InterfaceLanguageSettings";
import { RetainedViews, useViewActive } from "./RetainedViews";
import { useReadScope } from "./read-request";
import { LoadingBoundary } from "./LoadingBoundary";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SettingsDocument, SettingsTabs } from "./SettingsDocument";
import {
  createSettingsDocuments,
  type SettingsDocuments,
} from "./settings-documents";
import { DemoSettings } from "./DemoSettings";
import { TerminalPresetSettings } from "./TerminalPresetSettings";

import {
  readAutoSaveOnLeave,
  setAutoSaveOnLeave,
  subscribeAutoSaveOnLeave,
} from "./workspace-leave-preferences";
import { TopicSwitch } from "./TopicsCommon";
import "./WorkspaceLeaveDialog.css";

function WorkspaceSaveSettings() {
  useLocale();
  const enabled = useSyncExternalStore(
    subscribeAutoSaveOnLeave,
    readAutoSaveOnLeave,
  );
  const [error, setError] = useState("");
  return (
    <section className="workspace-leave-settings">
      <h3>{t("general.fileSaving")}</h3>
      <TopicSwitch
        checked={enabled}
        onChange={() => {
          try {
            setAutoSaveOnLeave(!enabled);
            setError("");
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >{t("general.autosaveWhenLeaving")}</TopicSwitch>
      <p>{t("general.saveEditsWithoutAskingWhenLeavingOverviewOrProject")}</p>
      <p className="hint">{t("general.ifTheFileChangedOnDiskYouWillStay")}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export const DEFAULT_SETTINGS_TAB = "workspace";

export function Settings({
  documents,
  onBack,
  selectedTab,
  onTabChange,
}: {
  documents?: SettingsDocuments;
  onBack?: () => void;
  selectedTab?: string;
  onTabChange?: (tab: string) => void;
}) {
  useLocale();
  const [ownStore] = useState(createSettingsDocuments);
  const store = documents ?? ownStore;
  const revision = useSyncExternalStore(store.subscribe, store.homeRevision);
  const removals = useSyncExternalStore(store.subscribe, store.removalRevision);
  const seenRemovals = useRef(removals);
  const initialized = useRef(false);
  const busy = useSyncExternalStore(store.subscribe, store.busy);
  const [ownTab, setOwnTab] = useState<string>(DEFAULT_SETTINGS_TAB),
    [profiles, setProfiles] = useState<string[]>(() => store.profiles()),
    [profile, setProfile] = useState(""),
    [creating, setCreating] = useState(false),
    [newName, setNewName] = useState(""),
    [error, setError] = useState("");
  const tab = selectedTab ?? ownTab,
    setTab = onTabChange ?? setOwnTab;
  const standalone =
    tab === "workspace" || tab === "terminal" || tab === "demonstrations";
  const viewActive = useViewActive();
  const read = useReadScope("settings");
  useEffect(() => {
    const since = seenRemovals.current;
    seenRemovals.current = removals;
    setProfiles((values) =>
      values.filter(
        (name) =>
          !store.wasRemovedSince(
            { scope: "home", kind: "profile", name },
            since,
          ),
      ),
    );
    setProfile((current) =>
      store.wasRemovedSince(
        { scope: "home", kind: "profile", name: current },
        since,
      )
        ? ""
        : current,
    );
  }, [store, removals]);
  const [attempt, setAttempt] = useState(0);
  const loadKey = JSON.stringify([revision, attempt]);
  const [settled, setSettled] = useState("");
  useEffect(() => {
    if (!viewActive || standalone) return;
    let alive = true;
    const catalogRemovalRevision = store.removalRevision();
    setError("");
    read("listSettings").then(
      (result) => {
        if (!alive || revision !== store.homeRevision()) return;
        const names = [
          ...new Set([...result.profiles, ...store.profiles()]),
        ].filter(
          (name) =>
            !store.wasRemovedSince(
              { scope: "home", kind: "profile", name },
              catalogRemovalRevision,
            ),
        );
        setProfiles(names);
        setSettled(loadKey);
        if (!initialized.current && store.removalRevision() === 0)
          setProfile((current) => current || names[0] || "");
        initialized.current = true;
      },
      (e) => {
        if (alive && revision === store.homeRevision()) {
          setError(e instanceof Error ? e.message : String(e));
          setSettled(loadKey);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [store, revision, attempt, viewActive, standalone]);
  function create() {
    const name = newName.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
      name.length > 180 ||
      profiles.includes(name)
    ) {
      setError(
        t("general.chooseAUniqueProfileNameOfUpTo180"),
      );
      return;
    }
    store.createProfile(name);
    setProfiles((values) => [...values, name]);
    setProfile(name);
    setNewName("");
    setCreating(false);
    setError("");
  }
  return (
    <section className="settings-panel structured-settings">
      <div className="section-heading">
        <div>
          <span className="eyebrow">{t("general.personalOnThisComputer")}</span>
          <h2>{t("general.generalSettings")}</h2>
        </div>
        {onBack && (
          <button className="quiet" disabled={busy} onClick={onBack}>{t("general.back")}</button>
        )}
      </div>
      <SettingsTabs
        label={t("general.generalSettingsSections")}
        tabs={[
          [DEFAULT_SETTINGS_TAB, t("general.generalTab")],
          ["config", t("general.configuration")],
          ...(window.goga?.terminalPresets
            ? [["terminal", t("general.terminal")] as const]
            : []),
          ...(typeof window.goga?.demoState === "function"
            ? [["demonstrations", t("general.demonstrationTab")] as const]
            : []),
          ["profiles", t("general.profiles")],
        ]}
        current={tab}
        onChange={setTab}
      />
      <RetainedViews activeKey={tab}>
        {tab === "workspace" ? (
          <div className="workspace-settings-sections"><InterfaceLanguageSettings /><WorkspaceSaveSettings /></div>
        ) : tab === "demonstrations" ? (
          <DemoSettings />
        ) : tab === "terminal" ? (
          <TerminalPresetSettings />
        ) : tab === "config" ? (
          <SettingsDocument
            store={store}
            source={{ scope: "home", kind: "config" }}
            path="~/.goga/config.yml"
            title={t("general.gogaConfiguration")}
            description={t("general.configurationForThisComputerManagePersonalProfilesInProfiles")}
          />
        ) : (
          <LoadingBoundary
            background={settled !== ""}
            pending={settled !== loadKey}
            label={t("general.loadingPersonalProfiles")}
          >
            <div className="subsection-intro">
              <p>{t("general.reusePersonalProfilesAcrossProjects")}</p>
              <button className="quiet" onClick={() => setCreating((v) => !v)}>{t("general.newProfile")}</button>
            </div>
            {creating && (
              <form
                className="new-profile"
                onSubmit={(e) => {
                  e.preventDefault();
                  create();
                }}
              >
                <label>{t("general.profileName")}<input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={t("general.eGCarefulReview")}
                    autoFocus
                  />
                </label>
                <button className="primary" type="submit">{t("general.createDraft")}</button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setCreating(false)}
                >{t("general.cancel")}</button>
              </form>
            )}
            <div className="master-detail">
              <div className="item-list">
                <span className="eyebrow">{t("general.personalProfiles")}</span>
                {profiles.map((name) => (
                  <button
                    key={name}
                    className={profile === name ? "selected" : ""}
                    aria-pressed={profile === name}
                    onClick={() => setProfile(name)}
                  >
                    {name}
                  </button>
                ))}
                <small>{t("general.projectProfilesCannotBeEditedHere")}</small>
              </div>
              {profile ? (
                <SettingsDocument
                  store={store}
                  source={{ scope: "home", kind: "profile", name: profile }}
                  path={`~/.goga/profiles/${profile}.yml`}
                  title={profile}
                  description={t("general.contentsOfTheSelectedPersonalProfileSwitchingProfilesPreserves")}
                />
              ) : (
                <p className="hint">
                  {profiles.length
                    ? t("general.selectAProfile")
                    : t("general.noPersonalProfilesYetCreateOneToGetStarted")}
                </p>
              )}
            </div>
          </LoadingBoundary>
        )}
      </RetainedViews>
      {tab === "profiles" && error && settled === loadKey && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === "profiles" && error && settled === loadKey && (
        <button onClick={() => setAttempt((n) => n + 1)}>{t("general.retryLoading")}</button>
      )}
      {!standalone && (
        <p className="memory-note">{t("general.draftsStayInThisWindowUntilYouCloseOr")}</p>
      )}
    </section>
  );
}
