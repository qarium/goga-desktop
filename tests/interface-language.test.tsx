// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { getLocale, setLocale, supportedLocales, t } from "../src/shared/i18n";
import {
  initializeInterfaceLanguage,
  useLocale,
} from "../src/renderer/useLocale";
import { InterfaceLanguageSettings } from "../src/renderer/InterfaceLanguageSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("ru");
});

it("starts in English without an explicit language and preserves an edit on change", async () => {
  const save = vi.fn(async (tag: string) => tag);
  vi.stubGlobal("goga", { setInterfaceLanguage: save });
  const dispose = await initializeInterfaceLanguage(window.goga);
  function Draft() {
    useLocale();
    return (
      <>
        <InterfaceLanguageSettings />
        <input aria-label="draft" defaultValue="" />
      </>
    );
  }
  render(<Draft />);
  expect(document.documentElement.lang).toBe("en");
  const draft = screen.getByRole("textbox", {
    name: "draft",
  }) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "Не переводить" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
    target: { value: "ru" },
  });
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Язык" })).toBeTruthy(),
  );
  expect(save).toHaveBeenCalledOnce();
  expect(document.documentElement.lang).toBe("ru");
  expect(screen.getByRole("textbox", { name: "draft" })).toBe(draft);
  expect(draft.value).toBe("Не переводить");
  dispose();
});

it("restores an explicit Russian preference and falls back for invalid preferences", async () => {
  const saved = await initializeInterfaceLanguage({
    initialInterfaceLanguage: "ru",
  });
  expect(getLocale()).toBe("ru");
  saved();
  const unsupported = await initializeInterfaceLanguage({
    initialInterfaceLanguage: "bogus",
  });
  expect(getLocale()).toBe("en");
  unsupported();
  expect(supportedLocales.map((x) => x.tag)).toEqual(
    expect.arrayContaining(["ru", "en"]),
  );
});

it("keeps the current language if saving fails, without exposing diagnostics", async () => {
  setLocale("en");
  vi.stubGlobal("goga", {
    setInterfaceLanguage: vi.fn().mockRejectedValue(Error("private info")),
  });
  render(<InterfaceLanguageSettings />);
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
    target: { value: "ru" },
  });
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Could not save the language preference.",
  );
  expect(getLocale()).toBe("en");
});

it("uses the selected language's plural rules and named parameters", () => {
  setLocale("en");
  expect(t("settings.unsavedFiles", { count: 1 })).toBe("1 unsaved file");
  expect(t("settings.unsavedFiles", { count: 2 })).toBe("2 unsaved files");
  setLocale("ru");
  expect(
    [1, 2, 5].map((count) => t("settings.unsavedFiles", { count })),
  ).toEqual([
    "1 несохранённый файл",
    "2 несохранённых файла",
    "5 несохранённых файлов",
  ]);
});

it("uses the saved preference instead of stale window arguments on renderer reload", async () => {
  const dispose = await initializeInterfaceLanguage({
    initialInterfaceLanguage: "en",
    getInterfaceLanguage: async () => "ru",
  });
  expect(document.documentElement.lang).toBe("ru");
  dispose();
});

it("keeps a live change that arrives while the saved language is still loading", async () => {
  let notify!: (tag: string) => void;
  let finishRead!: (tag: string) => void;
  const off = vi.fn();
  const boot = initializeInterfaceLanguage({
    onInterfaceLanguageChanged(listener) {
      notify = listener;
      return off;
    },
    getInterfaceLanguage: () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }),
  });
  notify("ru");
  finishRead("en");
  const dispose = await boot;
  expect(document.documentElement.lang).toBe("ru");
  dispose();
  expect(off).toHaveBeenCalledOnce();
});

it("keeps interpolated user text literal, even when it resembles a translation", () => {
  setLocale("en");
  const name = "$t(settings.language) {name}";
  expect(t("general.editPresetNamed", { name })).toBe("Edit " + name);
});
