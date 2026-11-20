import { expect, it } from "vitest";
import {
  preparationErrorMessage,
  documentSaveErrorMessage,
} from "../src/renderer/preparation-error";
it("strips only known Electron preparation wrapper and preserves the full host reason", () => {
  const reason =
    "Описание задачи не сохранено в Git. Детали: branch/feature · 2025.";
  expect(
    preparationErrorMessage(
      Error(
        `Error invoking remote method 'goga:check-topic-context-readiness': Error: ${reason}`,
      ),
    ),
  ).toBe(reason);
  expect(preparationErrorMessage(Error(reason))).toBe(reason);
  const other = `Error invoking remote method 'other-service': Error: ${reason}`;
  expect(preparationErrorMessage(Error(other))).toBe(other);
  expect(preparationErrorMessage(Error("Error: meaningful prefix"))).toBe(
    "Error: meaningful prefix",
  );
});
it("strips the actual read-request IPC envelope without stripping host details", () => {
  const reason =
    "Описание задачи выбранного топика не сохранено в Git. Сохраните данные задачи коммитом. Подробность: Error: исходный текст сохранён.";
  expect(
    preparationErrorMessage(
      Error(
        `Error invoking remote method 'goga:read-request': Error: ${reason}`,
      ),
    ),
  ).toBe(reason);
  const unknown = `Error invoking remote method 'goga:read-request-other': Error: ${reason}`;
  expect(preparationErrorMessage(Error(unknown))).toBe(unknown);
});

it.each(["read-overview-schema", "read-overview-contract"])(
  "removes the known direct Overview %s envelope but not the host reason",
  (channel) => {
    const reason =
      "Команда «goga schema» завершилась с кодом 1. Error: host detail";
    expect(
      preparationErrorMessage(
        Error(
          `Error invoking remote method 'goga:${channel}': Error: ${reason}`,
        ),
      ),
    ).toBe(reason);
  },
);

it.each(["save-project-document", "save-overview-file", "save-settings"])(
  "removes only the known %s wrapper while retaining the exact failure reason",
  (channel) => {
    const reason = "Нет прав на запись файла. Error: полезная подробность";
    expect(
      preparationErrorMessage(
        Error(
          `Error invoking remote method 'goga:${channel}': Error: ${reason}`,
        ),
      ),
    ).toBe(reason);
  },
);

it("does not disguise an uncertain write outcome as a pre-write file conflict", () => {
  const reason = "Не удалось подтвердить результат записи. Проверьте файл.";
  expect(
    documentSaveErrorMessage(
      Error(
        `Error invoking remote method 'goga:save-project-document': Error: ${reason}`,
      ),
    ),
  ).toBe(reason);
  const unknown =
    "Error invoking remote method 'goga:unknown-save': Error: stop";
  expect(documentSaveErrorMessage(Error(unknown))).toBe(unknown);
});

it.each([
  "copy-overview-paths",
  "prepare-overview-paste",
  "execute-overview-paste",
])(
  "shows the precise %s host reason without the Electron wrapper",
  (channel) => {
    const reason = "Файл изменился во время копирования. Вставка остановлена.";
    expect(
      preparationErrorMessage(
        Error(
          `Error invoking remote method 'goga:${channel}': Error: ${reason}`,
        ),
      ),
    ).toBe(reason);
  },
);
it("removes only the native project chooser envelope and preserves its actionable reason", () => {
  const reason = "Выбранная папка недоступна. Выберите другую папку.";
  expect(
    preparationErrorMessage(
      Error(
        `Error invoking remote method 'goga:choose-project': Error: ${reason}`,
      ),
    ),
  ).toBe(reason);
  const other = `Error invoking remote method 'goga:choose-project-other': Error: ${reason}`;
  expect(preparationErrorMessage(Error(other))).toBe(other);
});

it("keeps a project-removal refusal readable without the Electron envelope", () => {
  expect(
    preparationErrorMessage(
      Error(
        "Error invoking remote method 'goga:remove-project': Error: Сначала закройте терминалы этого проекта.",
      ),
    ),
  ).toBe("Сначала закройте терминалы этого проекта.");
});

it("never treats an untagged error from an older host as a conflict by its wording", () => {
  const reason = "Конфликт сохранения: подробность сторонней команды";
  expect(documentSaveErrorMessage(Error(reason))).toBe(reason);
});

it("uses the current language for a tagged write conflict without reading host wording", async () => {
  const { setLocale } = await import("../src/shared/i18n");
  const { DOCUMENT_SAVE_CONFLICT_PREFIX } = await import("../src/shared/project-documents");
  const reason = Error(`Error invoking remote method 'goga:save-overview-file': Error: ${DOCUMENT_SAVE_CONFLICT_PREFIX}older host wording`);
  setLocale("en");
  expect(documentSaveErrorMessage(reason)).toMatch(/draft .*editor/i);
  setLocale("ru");
  expect(documentSaveErrorMessage(reason)).toContain("Ваш черновик остался в редакторе");
  expect(documentSaveErrorMessage(reason)).not.toContain("older host wording");
});
