import {
  terminalChangedSchema,
  type TerminalAPI,
} from "../shared/terminal-control";
/** Called once by the shell preload, never by the terminal, dashboard or popup preload. */
export function createTerminalControlAPI(
  invoke: (channel: string, value?: unknown) => Promise<any>,
  listen: (channel: string, callback: (value: unknown) => void) => () => void,
): TerminalAPI {
  let connection: Promise<string> | undefined, documentId: string | undefined;
  const connect = () =>
    (connection ??= invoke("goga:terminal-connect").then((value) => {
      if (
        typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value,
        )
      )
        throw Error("Не удалось подключить управление терминалом.");
      documentId = value;
      return value;
    }));
  return {
    request: async (request) =>
      invoke("goga:terminal-request", { documentId: await connect(), request }),
    onChanged: (callback) => {
      const off = listen("goga:terminal-changed", (value) => {
        const parsed = terminalChangedSchema.safeParse(value);
        if (
          documentId &&
          parsed.success &&
          parsed.data.documentId === documentId
        ) {
          if (parsed.data.selectionScope !== undefined)
            callback({ selectionScope: parsed.data.selectionScope });
          else callback();
        }
      });
      // A subsequent explicit read reports connection failure to the UI.
      void connect().catch(() => {});
      return off;
    },
  };
}
