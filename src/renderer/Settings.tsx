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
  const enabled = useSyncExternalStore(
    subscribeAutoSaveOnLeave,
    readAutoSaveOnLeave,
  );
  const [error, setError] = useState("");
  return (
    <section className="workspace-leave-settings">
      <h3>Сохранение файлов</h3>
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
      >
        Автосохранение при переходе
      </TopicSwitch>
      <p>
        Сохранять правки без напоминания при выходе из «Обзора» или «Проекта»,
        смене проекта или топика и перед запуском.
      </p>
      <p className="hint">
        Если файл изменился на диске, переход остановится. Ваши правки останутся
        в редакторе.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

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
  const [ownStore] = useState(createSettingsDocuments);
  const store = documents ?? ownStore;
  const revision = useSyncExternalStore(store.subscribe, store.homeRevision);
  const removals = useSyncExternalStore(store.subscribe, store.removalRevision);
  const seenRemovals = useRef(removals);
  const initialized = useRef(false);
  const busy = useSyncExternalStore(store.subscribe, store.busy);
  const [ownTab, setOwnTab] = useState("config"),
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
        "Укажите уникальное имя профиля: до 180 символов, латинские буквы, цифры, точка, дефис или подчёркивание.",
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
          <span className="eyebrow">ЛИЧНОЕ · НА ЭТОМ КОМПЬЮТЕРЕ</span>
          <h2>Общие настройки</h2>
        </div>
        {onBack && (
          <button className="quiet" disabled={busy} onClick={onBack}>
            ← Назад
          </button>
        )}
      </div>
      <SettingsTabs
        label="Разделы общих настроек"
        tabs={[
          ["config", "Конфигурация"],
          ["profiles", "Профили"],
          ["workspace", "Рабочая область"],
          ...(typeof window.goga?.demoState === "function"
            ? [["demonstrations", "Демонстрации"] as const]
            : []),
          ...(window.goga?.terminalPresets
            ? [["terminal", "Терминал"] as const]
            : []),
        ]}
        current={tab}
        onChange={setTab}
      />
      <RetainedViews activeKey={tab}>
        {tab === "workspace" ? (
          <WorkspaceSaveSettings />
        ) : tab === "demonstrations" ? (
          <DemoSettings />
        ) : tab === "terminal" ? (
          <TerminalPresetSettings />
        ) : tab === "config" ? (
          <SettingsDocument
            store={store}
            source={{ scope: "home", kind: "config" }}
            path="~/.goga/config.yml"
            title="Конфигурация Goga"
            description="Домашняя конфигурация. Личные профили находятся в отдельном разделе «Профили»."
          />
        ) : (
          <LoadingBoundary
            background={settled !== ""}
            pending={settled !== loadKey}
            label="Загружаем личные профили…"
          >
            <div className="subsection-intro">
              <p>Личные профили для повторного использования в проектах.</p>
              <button className="quiet" onClick={() => setCreating((v) => !v)}>
                ＋ Новый профиль
              </button>
            </div>
            {creating && (
              <form
                className="new-profile"
                onSubmit={(e) => {
                  e.preventDefault();
                  create();
                }}
              >
                <label>
                  Имя профиля
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="например careful-review"
                    autoFocus
                  />
                </label>
                <button className="primary" type="submit">
                  Создать черновик
                </button>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => setCreating(false)}
                >
                  Отмена
                </button>
              </form>
            )}
            <div className="master-detail">
              <div className="item-list">
                <span className="eyebrow">ЛИЧНЫЕ ПРОФИЛИ</span>
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
                <small>Проектные профили здесь не редактируются.</small>
              </div>
              {profile ? (
                <SettingsDocument
                  store={store}
                  source={{ scope: "home", kind: "profile", name: profile }}
                  path={`~/.goga/profiles/${profile}.yml`}
                  title={profile}
                  description="Содержимое выбранного личного профиля. Черновики других профилей сохраняются при переключении."
                />
              ) : (
                <p className="hint">
                  {profiles.length
                    ? "Выберите профиль."
                    : "Личных профилей пока нет. Создайте новый профиль."}
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
        <button onClick={() => setAttempt((n) => n + 1)}>
          Повторить загрузку
        </button>
      )}
      {!standalone && (
        <p className="memory-note">
          Черновики сохраняются при переходах в этом окне до его закрытия или
          перезагрузки. На диск записывается только выбранный файл по кнопке
          «Сохранить».
        </p>
      )}
    </section>
  );
}
