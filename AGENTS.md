# Working on Goga Desktop

Goga Desktop is a macOS Electron app for working with local projects, topic working copies, and Goga pipelines. Desktop manages the interface, host integration, and run state; Goga CLI defines and runs the pipelines, and Docker supplies their runtime. Change Desktop here, not the external Goga project. See the [README](README.md) for the user journey.

## Start a session

1. Run `git rev-parse --show-toplevel` and `git status --short --branch`. Verify that `origin` identifies `qarium/goga-desktop` without copying private paths or credentials into reports. The primary branch is `main`, tracking `origin/main`. Preserve unrelated edits. Do not create another checkout or worktree without explicit permission.
2. Find the affected screen or command, then follow its request to the code that owns the behavior. Look for an existing test of that path before changing it.
3. Choose the smallest isolated test that exercises the change. Opening the application, starting a pipeline, and running every test are **not** session initialization steps.

## Find the code

| If the task concerns… | Start here |
| --- | --- |
| UI, project navigation, drafts | [React shell](src/renderer/App.tsx) and its feature components under [renderer](src/renderer/) |
| Windows, native panels, preload or IPC | [Electron entry](src/main/index.ts), [preload](src/main/preload.ts), [IPC handlers](src/main/ipc.ts) |
| Git, files, context ownership or launching Goga | [HostService](src/host/service.ts), then the corresponding [host module](src/host/) |
| Requests, responses and validation | [Bridge interface](src/shared/bridge.ts), [scope type](src/shared/context.ts), [shared schemas](src/shared/) |
| Terminal UI and native integration | [Terminal renderer](src/terminal/entry.ts), [terminal runtime](src/main/terminal-runtime.ts), [native helper](src/native/) |

To trace `readGitSummary`, start at the [renderer cache](src/renderer/git-summary-cache.ts). Its [read helper](src/renderer/read-request.ts) calls `window.goga.readRequest` through preload. The main process checks the sender and routes that request to the `read-git-summary` handler, which validates the scope before calling the host. The host resolves the working folder; an enabled UI control is not authorization.

## Keep contexts and user data separate

- A primary-project scope is explicit. Topic operations use the host-issued context for the project, year, topic and branch; its revision tracks freshness. Do not identify a copy by slug alone or fall back to the primary folder when a copy is unavailable. Keep drafts (including run kind), selections and late responses with their owner.
- Preserve host-side path, owner, revision and confirmation checks. For Git writes, recovery, sync or propagation, read the [Git and recovery contract](guides/git-and-recovery.md).
- Use disposable homes, projects, repositories, and fake executors for tests. Do not launch the user's Desktop, real Goga runs or Docker, or change their projects, settings or credentials without explicit authorization. Never bypass macOS safeguards.

## Verify a change

Use Node 24 (as in CI) and the lockfile. If dependencies are missing, run `npm ci` in this checkout. Match the check to the change:

| Check | Command |
| --- | --- |
| One relevant test (example) | `npm test -- tests/workspace-context.test.ts` |
| Full Vitest suite | `npm test` |
| TypeScript | `npm run typecheck` |
| Renderer, Electron bundles and native terminal components | `npm run build` (native macOS; does not open Desktop) |
| CI and release rules | `npm run test:release` (does not publish) |

Report what actually passed and what was not run. When adding, removing, or moving tests, follow the [CI guide](guides/ci.md). Before running a smoke script, check whether it launches an application, mounts a disk image, or writes outside a fixture.

## Publication boundaries

Public documentation is in English; keep localized UI strings and their test fixtures intact. Use synthetic data, including in screenshots. Never commit personal paths, credentials, account details or actual user configurations. Do not publish build output or directories named `docs` (any case or depth). Do not publish, rewrite history, or perform destructive Git operations without separate permission. For user-facing text and language packs, follow the [localization guide](guides/localization.md). To update the README animation, follow the [tour recording guide](guides/readme-tour.md). For commits, tags or packaging, follow the [release guide](guides/releases.md).
