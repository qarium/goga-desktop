# Continuous integration

Use this guide when changing tests, the build, or CI itself. The checked-in [ARM workflow](../.github/workflows/ci.yml), [Intel workflow](../.github/workflows/intel-tests.yml) and [domain map](../scripts/ci-test-domains.json) are authoritative for the current matrix and limits. Successful local tests are not a successful GitHub run.

## What blocks a release?

Pushes to `main` and pull requests run the full Vitest suite on macOS arm64, the lower-Git compatibility tests, CI/release contract tests, TypeScript and the native build. The final `complete` job requires **all** these dependencies to succeed. Independent jobs can overlap. Downstream jobs using `!cancelled()` may run after an ordinary upstream failure; this must not let a failed dependency pass the final gate.

The full Intel suite runs only by manual dispatch and does not replace the ARM gate. Release packaging and smoke checks still run on **both** native architectures; see [Releases](releases.md). Pin Actions by full SHA, give CI/build jobs read-only repository access, and never persist checkout credentials. CI must not use personal projects, real pipelines or Docker.

## Adding or moving a test

1. Add the test to the domain that owns the behavior, including UI regressions: Git workspace, Git conflicts, Git safety, topics/clones, terminal, runs, documents/settings, or shell. Update the domain map, and remove stale entries for renamed or deleted files.
2. Keep Vitest discovery authoritative. A new or moved file must be included **exactly once** in full ARM and full Intel coverage; an allowlist alone is not proof of completeness. Run the affected tests and `npm run test:release` to check mappings and workflow contracts.
3. Use [ARM weights](../scripts/ci-test-weights-arm64.json) to balance ARM subgroups; Intel uses [its own weights](../scripts/ci-test-weights.json). Shards and weights change scheduling, not coverage. The ARM domain sequencer runs expensive files first. Local and manual full runs outside ARM domains keep normal ordering.

ARM Vitest currently uses three workers and a 15-second generic test timeout; the manual Intel suite uses one worker. Keep verbose and JSON reports so individual completions and exact skipped tests are visible. Keep `GOGA_TOPIC_READONLY_CLI=/nonexistent/disabled` in CI for the existing opt-in real-CLI cases; do not add skips or automatic retries to make a release pass.

## Git compatibility and fixtures

The additional [Git compatibility suite](../scripts/test-git-compatibility.mjs) checks the exact Git 2.45.2 binary on PATH before running its target files in full with three isolated workers and ARM ordering. CI builds that version from a SHA-256-pinned archive under the runner's temporary directory, not over system Git. Cache the verified installation keyed by platform, architecture, toolchain and build script, and npm downloads; never cache test outcomes.

- Use [finite integration budgets](../tests/helpers/git-integration.ts) for measured slow paths. `GOGA_TEST_PROFILE=slow-git` triples only their explicit budgets; `default` leaves them unchanged. Reject unknown profiles. Do not raise production deadlines or the generic timeout. For example, the real CloneManager test has a 10-second budget (30 under the slow profile); setup, save, pause and completion can merit separate finite budgets.
- Drain setup and the whole test body with `installGitFixtureScope` before removing temporary repositories or restoring spies. Bound cleanup; unfinished work must not leak into the next test. Give each independent test file its own scope, repository, refs and index. Replay prior actions rather than passing live state across tests. Never weaken a product policy; disable automatic maintenance only for synthetic setup commands.
- Cache only immutable synthetic seeds, keyed by scenario and selected Git PATH. Do not hard-link mutable files or cache conflicts, ownership, active operation files, check results or user working copies. Preserve test bodies, assertions and registration when splitting files.
- Host writer fixtures use the finite standard NodeRunner limit (120 seconds), which covers nested owner/snapshot checks during ref transaction setup. Specific transport timeout tests retain their own shorter deadlines. Do not introduce artificial failures with a generic ten-second writer limit.
- UI tests wait for `aria-busy` to clear and controls to become enabled before querying and clicking; do not repeat clicks. Real terminal tests resolve Apple's actual Python executable in a bounded preflight. Distinguish command delivery from prompt readiness using PID markers, subscribe to close before the action and bound disposal.
- Different Git versions may leave or remove an empty ref directory after packed-branch discard. Verify public and packed refs, selected and unrelated files, and that no operation artifacts survive. A remaining directory is acceptable only if it is a genuine empty directory.

## Measuring changes

The target is 15 minutes end to end for automatic CI, including setup; job limits and local timings are not evidence that this was met. Check a complete remote run. ARM test/build jobs normally have 15-minute limits, with a separate compatibility limit; manual Intel jobs have 60-minute ceilings. The [manual diagnostic workflow](../.github/workflows/ci-diagnostics.yml) compares one, two and three workers on the same four heavy cases. Do not run it against the same runner slots during final CI.

Historical context, **not** configuration: extra workers sped up local Git samples but oversubscribed remote conflict tests. Splitting independent files and giving measured cases finite budgets proved more useful than raising all timeouts. Prior timeouts also exposed a real difference in empty-ref behavior between Git versions and a terminal fixture that detected command delivery before the prompt was ready. Preserve the resulting checks; do not infer current capacity, budgets or a successful run from those incidents.
