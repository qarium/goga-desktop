import { randomUUID } from "node:crypto";
import {
  terminalRegistrySchema,
  type TerminalRegistry,
} from "../shared/terminal";
import { PrivateFileError, TerminalPrivateFile } from "./terminal-private-file";
const messages = {
  invalid: "Список вкладок терминала повреждён или несовместим.",
  conflict:
    "Список вкладок терминала изменён. Обновите данные перед сохранением.",
  unavailable: "Не удалось прочитать или сохранить список вкладок терминала.",
};
function validate(v: unknown): TerminalRegistry {
  try {
    return terminalRegistrySchema.parse(v);
  } catch {
    throw new PrivateFileError(messages.invalid);
  }
}
function parse(raw: string | undefined): TerminalRegistry {
  if (raw === undefined)
    return {
      schemaVersion: 1,
      revision: "00000000-0000-4000-8000-000000000000",
      projects: {},
    };
  try {
    return validate(JSON.parse(raw));
  } catch {
    throw new PrivateFileError(messages.invalid);
  }
}
/** Metadata only: never starts, restores, enumerates or stops processes. */
export class TerminalStore {
  private readonly store: TerminalPrivateFile;
  constructor(home: string) {
    this.store = new TerminalPrivateFile(home, "terminals", messages);
  }
  load(): Promise<TerminalRegistry> {
    return this.store.run((raw) => ({ value: parse(raw) }));
  }
  async save(input: TerminalRegistry): Promise<TerminalRegistry> {
    const value = validate(input);
    return this.store.run((raw, changed) => {
      if (parse(raw).revision !== value.revision || changed)
        throw new PrivateFileError(messages.conflict);
      const next = { ...value, revision: randomUUID() };
      return { value: next, next };
    });
  }
}
