import { t as msg } from "../shared/i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import type {
  GitBranchInventory,
  GitBranchResult,
} from "../shared/git-branches";
import { readWithSignal } from "./read-request";
import { topicError } from "./TopicsCommon";
import {
  formatGitDiagnostics,
  hasGitDiagnostics,
} from "./git-operation-diagnostics";

/** One retained primary-project owner. Reading is replaceable; an issued write is not. */
export function useGitBranchMenu({
  projectId,
  active,
  open,
  disabled,
  blocked,
  revision,
  attempt,
  flight,
  onChanged,
}: {
  projectId: string;
  active: boolean;
  open: boolean;
  disabled: boolean;
  blocked?: string;
  revision: number;
  attempt: number;
  flight: MutableRefObject<boolean>;
  onChanged(projectId: string, change?: "references-only"): void;
}) {
  const [inventory, setInventory] = useState<GitBranchInventory | null>(null),
    [loading, setLoading] = useState(false),
    [fetching, setFetching] = useState(false);
  const [executionDiagnostic, setExecutionDiagnostic] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [stale, setStale] = useState(false),
    [newRefs, setNewRefs] = useState<string[]>([]),
    [reviewRequired, setReviewRequired] = useState(false);
  const admission = useRef<AbortController | null>(null);
  const alive = useRef(true),
    epoch = useRef(0),
    busy = useRef(false),
    read = useRef<AbortController | null>(null);
  const current = useRef({ active, open, disabled, blocked, onChanged });
  current.current = { active, open, disabled, blocked, onChanged };
  const allowed = () =>
    alive.current &&
    current.current.active &&
    !current.current.disabled &&
    !current.current.blocked;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!open) {
      setNewRefs([]);
      setError("");
      setNotice("");
    }
  }, [open]);
  // A temporary navigation/fence revokes this admission, even if the owner is
  // active again by the time its old reply arrives. Issued writes are separate.
  useLayoutEffect(
    () => () => admission.current?.abort(),
    [active, disabled, blocked],
  );
  const readInventory = async (signal: AbortSignal) => {
    const value = await readWithSignal(signal, "readGitBranches", projectId);
    if (value.projectId !== projectId)
      throw Error(msg("git.theBranchListBelongsToAnotherProject"));
    return value;
  };
  useEffect(() => {
    if (!active || !open || disabled || busy.current) return;
    const controller = new AbortController(),
      id = ++epoch.current;
    read.current = controller;
    setLoading(true);
    void readInventory(controller.signal)
      .then((value) => {
        if (controller.signal.aborted || id !== epoch.current || !alive.current)
          return;
        setInventory(value);
        setStale(false);
      })
      .catch((e) => {
        if (controller.signal.aborted || id !== epoch.current || !alive.current)
          return;
        setError(topicError(e));
        setNotice("");
        setStale(true);
      })
      .finally(() => {
        if (!controller.signal.aborted && id === epoch.current && alive.current)
          setLoading(false);
      });
    return () => controller.abort();
  }, [active, open, disabled, projectId, revision, attempt]);
  async function update(checkOnly = false) {
    if (flight.current || !allowed() || (!checkOnly && reviewRequired)) return;
    flight.current = true;
    busy.current = true;
    epoch.current++;
    read.current?.abort();
    setLoading(false);
    setFetching(true);
    setError("");
    setNotice("");
    let issued = false,
      successful = false,
      before: GitBranchInventory | null = null,
      diagnostic = "",
      needsReview = false;
    const controller = new AbortController();
    admission.current = controller;
    try {
      before = await readInventory(controller.signal);
      if (!allowed() || controller.signal.aborted) return;
      if (checkOnly && !reviewRequired) {
        setInventory(before);
        setStale(false);
        setNotice(msg("git.listStateRefreshed"));
        return;
      }
      const prepared = await readWithSignal(
        controller.signal,
        "prepareGitBranch",
        { projectId, revision: before.revision, action: "fetch" },
      );
      if (!allowed() || controller.signal.aborted) return;
      if (
        prepared.projectId !== projectId ||
        prepared.action !== "fetch" ||
        prepared.remote !== "origin"
      )
        throw Error(
          msg("git.fetchConfirmationBelongsToAnotherOperationOrProject"),
        );
      if (checkOnly) {
        setReviewRequired(false);
        setExecutionDiagnostic("");
        setStale(false);
        setInventory(before);
        setNotice(msg("git.stateVerifiedBranchesCanNowBeFetched"));
        return;
      }
      issued = true;
      admission.current = null;
      const result: GitBranchResult = await window.goga.executeGitBranch(
        prepared.token,
      );
      if (result.projectId !== projectId || result.action !== "fetch")
        throw Error(
          msg("git.theResultBelongsToAnotherOperationCheckTheGitState"),
        );
      successful = !hasGitDiagnostics(result);
      if (!successful) {
        diagnostic = formatGitDiagnostics(result);
        needsReview =
          result.status === "uncertain" ||
          !!result.lockRetained ||
          !!result.retainedLocks?.length ||
          !!result.uncheckedLocks?.length ||
          !!result.recoveryPath ||
          !!result.recoveryUnverified;
      }
    } catch (e) {
      if (!controller.signal.aborted || issued) diagnostic = topicError(e);
      needsReview = issued;
    } finally {
      // A failed online command may still have imported some refs. Never reuse its old revision.
      if (
        (!controller.signal.aborted || issued) &&
        (!checkOnly || diagnostic)
      ) {
        try {
          const fresh = await readInventory(new AbortController().signal);
          if (alive.current) {
            setInventory(fresh);
            setStale(false);
            if (successful && before) {
              const old = new Set(before.remote.map((r) => r.ref));
              setNewRefs(
                current.current.open
                  ? fresh.remote
                      .filter(
                        (r) =>
                          r.ref.startsWith("refs/remotes/origin/") &&
                          !old.has(r.ref),
                      )
                      .map((r) => r.ref)
                  : [],
              );
              setNotice(msg("git.branchListRefreshed"));
            }
          }
        } catch (e) {
          diagnostic = [diagnostic, topicError(e)].filter(Boolean).join("\n\n");
          if (alive.current) {
            setStale(true);
            setNotice("");
          }
        }
      }
      // Notify the issuing owner even after unmount; never navigate or reopen its menu.
      if (issued) current.current.onChanged(projectId, "references-only");
      if (alive.current) {
        setError(diagnostic);
        if (needsReview) {
          setReviewRequired(true);
          setExecutionDiagnostic(diagnostic);
        }
        setFetching(false);
      }
      if (admission.current === controller) admission.current = null;
      busy.current = false;
      flight.current = false;
    }
  }
  return {
    inventory,
    setInventory,
    loading,
    fetching,
    error: [...new Set([executionDiagnostic, error].filter(Boolean))].join(
      "\n\n",
    ),
    notice,
    stale,
    newRefs,
    reviewRequired,
    update: () => update(false),
    checkState: () => update(true),
  };
}
