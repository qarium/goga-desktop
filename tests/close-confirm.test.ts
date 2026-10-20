import { it, expect, vi } from "vitest";
vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
import { dialog } from "electron";
import { confirmCloseRun } from "../src/main/confirm-close";
it.each([0, 1])(
  "uses native safe cancel defaults and confirms only response one (%s)",
  async (response) => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response,
      checkboxChecked: false,
    });
    expect(
      await confirmCloseRun(
        {} as any,
        { pipeline: "build", topic: "topic" } as any,
      ),
    ).toBe(response === 1);
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      {},
      expect.objectContaining({
        message: "Остановить конвейер и закрыть вкладку?",
        buttons: ["Отмена", "Остановить и закрыть"],
        defaultId: 0,
        cancelId: 0,
      }),
    );
  },
);
