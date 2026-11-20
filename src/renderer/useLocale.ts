import { useSyncExternalStore } from "react";
import { getLocale, setLocale, subscribeLocale } from "../shared/i18n";

export type LanguageBridge = {
  readonly initialInterfaceLanguage?: string;
  getInterfaceLanguage?: () => Promise<string>;
  setInterfaceLanguage?: (tag: string) => Promise<string>;
  onInterfaceLanguageChanged?: (listener: (tag: string) => void) => () => void;
};

export function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/** Bootstrap once before mounting React. Never remount the app to change language. */
export async function initializeInterfaceLanguage(bridge?: LanguageBridge) {
  let updated = false;
  const syncDocument = () => {
    document.documentElement.lang = getLocale();
  };
  const offDocument = subscribeLocale(syncDocument);
  const offNative = bridge?.onInterfaceLanguageChanged?.((tag) => {
    updated = true;
    setLocale(tag);
  });
  try {
    // Window arguments seed new windows; on renderer reload the persisted choice may have changed.
    const initial = bridge?.getInterfaceLanguage
      ? await bridge.getInterfaceLanguage()
      : bridge?.initialInterfaceLanguage;
    if (!updated) setLocale(initial ?? "en");
  } catch {
    if (!updated) setLocale(bridge?.initialInterfaceLanguage ?? "en");
  }
  syncDocument();
  return () => {
    offNative?.();
    offDocument();
  };
}
