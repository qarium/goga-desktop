import { useState, useRef, useId } from "react";
import { setLocale, supportedLocales, t } from "../shared/i18n";
import { useLocale, type LanguageBridge } from "./useLocale";

export function InterfaceLanguageSettings() {
  const locale = useLocale(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  const id = useId();
  const pending = useRef(false);
  async function select(tag: string) {
    if (pending.current || tag === locale) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const bridge: LanguageBridge = window.goga;
      if (!bridge?.setInterfaceLanguage) throw Error();
      const persisted = await bridge.setInterfaceLanguage(tag);
      if (persisted !== tag) throw Error();
      setLocale(persisted);
    } catch {
      setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-leave-settings interface-language-settings">
      <h3>
        <label htmlFor={id}>{t("settings.language")}</label>
      </h3>
      <select
        id={id}
        aria-describedby={id + "-hint"}
        value={locale}
        disabled={busy}
        onChange={(e) => void select(e.currentTarget.value)}
      >
        {supportedLocales.map(({ tag, name }) => (
          <option key={tag} value={tag} lang={tag}>
            {name}
          </option>
        ))}
      </select>
      <p className="hint" id={id + "-hint"}>
        {t("settings.languageHint")}
      </p>
      {error && (
        <p role="alert" className="error">
          {t("settings.languageSaveError")}
        </p>
      )}
    </section>
  );
}
