import { z } from "zod";
import {
  defaultBoardPreferences,
  type TopicsBoardPreferences,
} from "./topics-board-model";
const schema = z
  .object({
    schemaVersion: z.literal(1),
    view: z.enum(["table", "board"]),
    columns: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(128)
              .refine((s) => s !== "unassigned"),
            name: z.string().trim().min(1).max(64),
          })
          .strict(),
      )
      .max(50),
    statusCategory: z.preprocess(
      (input) =>
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? Object.entries(input)
          : undefined,
      z
        .array(
          z.tuple([
            z.string().min(1).max(256),
            z.string().min(1).max(128).nullable(),
          ]),
        )
        .max(1000)
        .transform(
          (entries) =>
            Object.assign(
              Object.create(null),
              Object.fromEntries(entries),
            ) as Record<string, string | null>,
        ),
    ),
  })
  .strict()
  .superRefine((p, ctx) => {
    const ids = new Set(p.columns.map((c) => c.id)),
      names = new Set(p.columns.map((c) => c.name.toLocaleLowerCase()));
    if (
      ids.size !== p.columns.length ||
      names.size !== p.columns.length ||
      Object.keys(p.statusCategory).length > 1000 ||
      Object.values(p.statusCategory).some((c) => c !== null && !ids.has(c))
    )
      ctx.addIssue({ code: "custom", message: "Invalid board preferences" });
  });
export const boardPreferencesKey = (projectId: string) =>
  `goga.desktop.topicsBoard.v1.${projectId}`;
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
export function readBoardPreferences(
  storage: Storage,
  projectId: string,
): { value: TopicsBoardPreferences; error?: string } {
  try {
    const text = storage.getItem(boardPreferencesKey(projectId));
    if (text === null) return { value: defaultBoardPreferences() };
    return { value: schema.parse(JSON.parse(text)) };
  } catch {
    return {
      value: defaultBoardPreferences(),
      error:
        "Не удалось прочитать настройки доски. Используется начальная раскладка.",
    };
  }
}
export function writeBoardPreferences(
  storage: Storage,
  projectId: string,
  prefs: TopicsBoardPreferences,
): { error?: string } {
  try {
    storage.setItem(
      boardPreferencesKey(projectId),
      JSON.stringify(schema.parse(prefs)),
    );
    return {};
  } catch {
    return {
      error:
        "Настройки доски не сохранены. Изменения доступны до закрытия окна.",
    };
  }
}
