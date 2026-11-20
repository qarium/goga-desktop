# Releasing Goga Desktop

The [release workflow](../.github/workflows/release.yml) builds macOS DMGs for Apple Silicon and Intel. A tag, a local package, a green ARM build or an automated smoke check alone is not a published release. The [CI guide](ci.md) describes the required checks on the candidate commit.

## Before publishing

- Get explicit permission for remote operations, the intended scope and the version. Use the canonical checkout and the existing `main` history tracking `origin/main`. Verify the effective author and committer against the maintainer's intended identity; if authorized, change only repository-local settings. Author metadata is not a cryptographic signature.
- Inspect the candidate changes, the entire outgoing commit range and the snapshot. Commit only reviewed files in scope. Exclude secrets, user data, local state, dependencies, build output and any directory named `docs` (case-insensitive at every depth). Ignore rules do not protect files already tracked.
- Never replace `.git`, rewrite public history, or republish backups without separate permission. In particular, do not merge or publish a historical local `prototype` branch, other backups or old tags: they may contain private material. Do not use `git push --all`, `--mirror`, or `--tags` for a normal release. Never move an existing tag to fix a failed release.
- Validate the intended version and confirm full green ARM CI for the **exact commit**, not just its branch. Use `vX.Y.Z` or `vX.Y.Z-{alpha,beta,rc}.N`; numeric components have no leading zeros except `0`, and no other suffix or metadata is permitted. The [version script](../scripts/release-version.mjs) is authoritative. Do not bump versions manually; the tag supplies the asset version without its leading `v`.

## What the workflow does

1. A push of a `v*` tag starts the release path. The workflow validates the tag, its dereferenced commit, ancestry in `origin/main` and successful full ARM CI for that commit. Manual dispatch is validation-only, from `main`, with a strictly validated test version; it creates no tag or release and cannot publish.
2. Native arm64 and x64 jobs confirm the runner, Node and executable architectures. They run on `macos-15` and `macos-15-intel`, respectively. Each uses locked dependencies and injects the version **only in its disposable checkout**; CI never commits it back. The release does not rerun full Vitest, TypeScript or standalone release-rule tests already required for that SHA. It does run the packaged-DMG smoke check on both architectures.
3. Only the separate publisher job may write to the repository, and only after both native jobs succeed. It rechecks the gate, creates a draft, verifies server asset names, sizes, SHA-256 values and draft status, then publishes two DMGs and `SHA256SUMS`. The tag must already exist and resolve to the expected commit in `qarium/goga-desktop`. Neither workflow nor publisher creates or pushes tags. An existing release **including a draft** blocks reruns; investigate partial drafts manually, do not automatically delete or overwrite them.
4. Verify the published release and its three assets before reporting success. Signing is **ad hoc**, not Developer ID or Apple notarization. Do not disable Gatekeeper or automatically use personal certificates. Builds, signatures, installation and launch are different checks.

Keep Actions pinned to full commit SHAs. CI and build jobs use read-only repository credentials, do not persist Git credentials and receive no publishing secrets. No release step needs real Goga or Docker.

## Local checks and packaging

| Command | Effect |
| --- | --- |
| `npm run test:release` | Tests workflow rules, packaging, verification and publisher logic using fake publication transport. Does not publish. |
| `RELEASE_TAG=v1.2.3 node scripts/release-version.mjs --check` | Example: validates the tag syntax only, prints the asset version and does not edit manifests. |
| `RELEASE_TAG=v1.2.3 npm run release:version` | Example: writes the validated version into manifests. **Only** use in an authorized disposable build checkout, never in the working repository. |
| `npm run build`, then `npm run package:release -- --arm64` or `--x64` | Builds and packages the matching native target without publication. The output name is `Goga-Desktop-VERSION-ARCH.dmg`. A cross-build does not establish native support. |

Packaging and smoke are not routine session-start commands. Review their side effects and obtain permission before running them on a user's machine.

## Packaged smoke: what it proves

[DMG verification](../scripts/verify-dmg.mjs) takes a validated `RELEASE_TAG`, DMG path and architecture, with optional `--ui`. It mounts the image read-only, checks the Applications link, Mach-O architecture, ad-hoc signature and consistent ASAR, Info.plist and renderer versions, executes the packaged binary in Node mode under a temporary home, then unmounts it.

Release jobs also pass `--ui`. An external Node 24 controller starts the packaged app with a temporary loopback-only endpoint for the test process. It checks readiness/version, a setting round trip, one Git commit in a synthetic local repository without hooks, signing or remote, actual PTY input/output, safe terminal closure and normal exit. The test exercises the regular main process, preload and IPC without changing product DevTools/sandbox settings. It is not a Finder install, a Gatekeeper check or a clean-Mac install test.

Native jobs use bounded install, build and package phases recorded in `phases.jsonl`. The 15-minute job, 160-second smoke, 20-second unmount allowance and four-minute outer smoke step are ceilings, not verified end-to-end times. Never skip or automatically retry a failed check. Missing receipts, fatal or protocol errors, abnormal exit, unverified termination, or a failed unmount block success. Report a failure to remove an already unmounted temporary directory separately from a still-running process.

The isolated build runs the lockfile-installed Electron installer explicitly before Mach-O verification and the native PTY rebuild; package presence does not establish binary presence. Cache only verified download inputs (Electron downloads/headers and builder tools), keyed by architecture, lockfile and toolchain. Rebuild native modules and verify versions, architecture and hashes on each run. Do not cache app state, `node_modules`, finished assets or smoke results. Never forward user-supplied Electron/Node injection flags to child processes. The workflow uploads bounded reports from `work/release-report/` using `GOGA_RELEASE_REPORT_DIR`, including on failure; it never uploads the temporary home, Git repository or profile.
