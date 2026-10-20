import { expect, it } from "vitest";
import { preparationErrorMessage } from "../src/renderer/preparation-error";
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
