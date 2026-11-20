# Git operations and recovery

Read this when changing a Git writer, working-copy resolution, run ownership, or the UI that reports an operation's result. The [agent guide](../AGENTS.md) covers general context isolation.

## Identify the operation first

A topic action in a card and a similarly named repository action in the header need not use the same command. Trace the actual handler and scope. For example, local sync into internal refs and the separate previewed apply to the current base are not remote publication. The explicitly named repository propagation action can synchronize the copy and publish the base. See [context sync](../src/host/context-sync.ts) and [repository actions](../src/host/repository-actions.ts). Keep the confirmation and the actual destination consistent.

## Write and report a result

- [HostService](../src/host/service.ts) dispatches commit, discard and conflict save to `GitCommitCoordinator`, `NativeGitDiscardActions` and `NativeGitConflictActions`. Branch operations, merge, rebase, cherry-pick/revert and Goga handoff use the native journal. Shared action code for preview and admission must not introduce another executor or a Git-version fallback.
- Recheck owner, revision, the one-time confirmation, working tree/index and the identity of a paused operation before writing. A command's success flag cannot replace the journal, protective snapshot or readback.
- A service lock for an existing clone must not create or repair its directories or permissions. Never redirect the write to the primary project if ownership is lost. Sanitize errors from both the action and ownership release, including failures after a write.
- To mark a paused operation complete, verify the native result for the requested scope/action, process exit, survival of unrelated changes and cleanup of recovery data. Closing a window is not cancellation of an in-progress write.
- Merge, sequence, branch and handoff finalize recovery at the outer [native completion boundary](../src/host/git-native-completion.ts). A nested handoff must not finalize early. Commit, discard and conflict save keep their deferred cleanup guards. Unknown outcome, lost scope or unresolved cleanup means retaining recovery data and blocking automatic replay, not reporting success.
- For [run recovery](../src/host/run-recovery.ts), launch admission is not proof of a started lease. A test that acts on a running payload must wait for that payload's PID marker. A protected read during atomic lease replacement can fail closed; do not loosen link-count or ownership checks or infer that the process stopped.

When migrating tests, move the user-visible invariant to the actual native spawn, exit, readback or recovery boundary. Do not preserve obsolete HEAD/index pins or custom Git serialization just to retain an old fault-injection path. Replace each removed check with a verified equivalent. For fixture isolation and finite budgets, see the [CI guide](ci.md).
