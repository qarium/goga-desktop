import { useEffect, useRef, useState } from "react";
import { preparationErrorMessage } from "./preparation-error";
import {
  readAutoSaveOnLeave,
  setAutoSaveOnLeave,
} from "./workspace-leave-preferences";

export type WorkspaceLeaveFile = {
  path: string;
  readText?: () => string | null;
  preflight?: () => Promise<void>;
  save: () => Promise<void>;
  acceptSavedText?: () => Promise<void>;
  reveal?: () => void;
};

class FileSaveFailure extends Error {
  constructor(
    readonly file: WorkspaceLeaveFile,
    cause: unknown,
  ) {
    super(preparationErrorMessage(cause));
  }
}

/** Entries belong to one captured workspace. Project first: its guarded write
 * can then be accepted by an identical Overview buffer without a second write. */
export async function saveLeaveFiles(
  files: readonly WorkspaceLeaveFile[],
  current = () => true,
) {
  const groups = new Map<string, WorkspaceLeaveFile[]>();
  const expected = new Map<WorkspaceLeaveFile, string | null | undefined>();
  const check = (file: WorkspaceLeaveFile) => {
    if (!current()) throw Error("Рабочая область изменилась. Переход отменён.");
    if (
      file.readText &&
      (expected.get(file) === null || file.readText() !== expected.get(file))
    )
      throw Error("Черновик изменился. Проверьте правки перед сохранением.");
  };
  let active = files[0];
  try {
    for (const file of files) {
      active = file;
      const group = groups.get(file.path) ?? [];
      expected.set(file, file.readText?.());
      check(file);
      if (
        group.length &&
        (!file.acceptSavedText ||
          !file.readText ||
          expected.get(group[0]) !== expected.get(file))
      )
        throw Error(
          "Файл изменён в двух редакторах. Сверьте правки в «Обзоре» и «Проекте» и сохраните нужный вариант.",
        );
      group.push(file);
      groups.set(file.path, group);
    }
    for (const file of files) {
      active = file;
      check(file);
      await file.preflight?.();
    }
    // A different buffer may have changed while checking the last file.
    // Catch that before writing even an unrelated earlier group.
    for (const file of files) {
      active = file;
      check(file);
    }
    for (const group of groups.values()) {
      for (const file of group) {
        active = file;
        check(file);
      }
      for (const [index, file] of group.entries()) {
        active = file;
        check(file);
        if (index === 0) await file.save();
        else await file.acceptSavedText!();
      }
    }
  } catch (cause) {
    throw new FileSaveFailure(active, cause);
  }
}

type Intent = {
  files: WorkspaceLeaveFile[];
  collect: () => WorkspaceLeaveFile[];
  current: () => boolean;
  go: () => void;
  launching: boolean;
};
type Pending = {
  intent: Intent;
  busy: boolean;
  silent: boolean;
  failure?: { path: string; message: string; reveal?: () => void };
};

export function useWorkspaceLeave() {
  const slot = useRef<Pending | null>(null);
  const [view, setView] = useState<Pending | null>(null);
  const publish = (next: Pending | null) => {
    slot.current = next;
    setView(next);
  };
  useEffect(
    () => () => {
      slot.current = null;
    },
    [],
  );
  function finish(intent: Intent) {
    publish(null);
    if (intent.current()) intent.go();
  }
  async function write(remember: boolean) {
    const pending = slot.current;
    if (!pending || pending.busy || pending.failure) return;
    const { intent } = pending;
    if (!intent.current()) {
      publish(null);
      return;
    }
    publish({ ...pending, busy: true });
    const live = () => slot.current?.intent === intent && intent.current();
    try {
      await saveLeaveFiles(intent.files, live);
      if (!live()) {
        if (slot.current?.intent === intent) publish(null);
        return;
      }
      const extra = intent.collect()[0];
      if (extra)
        throw new FileSaveFailure(
          extra,
          "В редакторе остались новые правки. Проверьте их перед переходом.",
        );
      if (remember) setAutoSaveOnLeave(true);
    } catch (error) {
      if (slot.current?.intent !== intent) return;
      if (!intent.current()) {
        publish(null);
        return;
      }
      const file = error instanceof FileSaveFailure ? error.file : undefined;
      publish({
        ...pending,
        busy: false,
        silent: false,
        failure: {
          path: file?.path ?? "",
          message: preparationErrorMessage(error),
          reveal: file?.reveal,
        },
      });
      return;
    }
    finish(intent);
  }
  return {
    view,
    blocked: () => !!slot.current,
    request(intent: Omit<Intent, "files">) {
      if (slot.current) return;
      const files = intent.collect();
      if (!files.length) {
        intent.go();
        return;
      }
      const silent = readAutoSaveOnLeave();
      publish({ intent: { ...intent, files }, silent, busy: false });
      if (silent) void write(false);
    },
    save: (remember: boolean) => {
      void write(remember);
    },
    stay: () => {
      if (!slot.current?.busy) publish(null);
    },
    keep: () => {
      const p = slot.current;
      if (p && !p.busy && !p.failure) finish(p.intent);
    },
    reveal: () => {
      const p = slot.current;
      if (!p || p.busy) return;
      publish(null);
      if (p.intent.current()) p.failure?.reveal?.();
    },
  };
}
