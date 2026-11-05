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
