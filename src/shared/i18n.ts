import { createInstance } from "i18next";
import {
  languages,
  resources,
  type MessageKey,
} from "./locale-packs.generated";

export const supportedLocales: readonly { tag: string; name: string }[] =
  languages;
export const isSupportedLocale = (value: unknown): value is string =>
  typeof value === "string" &&
  supportedLocales.some(({ tag }) => tag === value);
const engine = createInstance();
void engine.init({
  resources,
  lng: "en",
  fallbackLng: "en",
  load: "currentOnly",
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  returnEmptyString: false,
  interpolation: {
    prefix: "{",
    suffix: "}",
    escapeValue: false,
    skipOnVariables: true,
  },
});
const listeners = new Set<() => void>();
export const getLocale = (): string => engine.language;
export function setLocale(value: string) {
  const tag = isSupportedLocale(value) ? value : "en";
  if (tag === getLocale()) return;
  // All resources are bundled; changing language completes synchronously.
  void engine.changeLanguage(tag);
  for (const listener of listeners) listener();
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function t(
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  // Only count has grammar semantics. Data values must not override i18next
  // options (e.g. lng or defaultValue), and are never interpreted as markup.
  const options = params
    ? {
        replace: params,
        ...(typeof params.count === "number" ? { count: params.count } : {}),
      }
    : {};
  return engine.t(key, options);
}
