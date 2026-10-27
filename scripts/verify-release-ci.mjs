import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { versionFromTag } from "./release-version.mjs";

const expectedRepository = "qarium/goga-desktop";
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

/** Read-only, dependency-free release admission. Never reruns tests or waits for CI. */
export async function verifyReleaseCI({
  repository,
  sha,
  token,
  transport = fetch,
}) {
  if (
    repository !== expectedRepository ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    !token
  )
    throw Error("Release blocked: invalid repository, commit or API token.");
  const base = `https://api.github.com/repos/${expectedRepository}/actions`;
  const query = new URLSearchParams({
    head_sha: sha,
    event: "push",
    branch: "main",
    per_page: "100",
  });
  async function request(url) {
    let response;
    try {
      response = await transport(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      throw Error(
        "Release blocked: CI status could not be read (network error or timeout). Retry the release after checking CI.",
      );
    }
    if (!response.ok)
      throw Error(
        `Release blocked: GitHub CI API returned HTTP ${response.status}.`,
      );
    try {
      return await response.json();
    } catch {
      throw Error("Release blocked: invalid CI API response.");
    }
  }
  function identity(run) {
    if (
      !run ||
      !positiveInteger(run.id) ||
      !positiveInteger(run.run_attempt) ||
      !positiveInteger(run.workflow_id) ||
      run.path !== ".github/workflows/ci.yml" ||
      run.event !== "push" ||
      run.head_branch !== "main" ||
      run.head_sha !== sha ||
      run.repository?.full_name !== expectedRepository ||
      run.head_repository?.full_name !== expectedRepository
    )
      throw Error(
        "Release blocked: CI run does not match the exact main commit and trusted workflow.",
      );
  }
  function successful(run) {
    identity(run);
    if (run.status !== "completed" || run.conclusion !== "success")
      throw Error(
        `Release blocked: latest CI for ${sha} is not successful. Open https://github.com/${expectedRepository}/actions/runs/${run.id}; finish or repair CI before retrying the release.`,
      );
  }
  async function latest() {
    const data = await request(`${base}/workflows/ci.yml/runs?${query}`);
    if (
      !Number.isSafeInteger(data?.total_count) ||
      data.total_count < 0 ||
      data.total_count > 100 ||
      !Array.isArray(data.workflow_runs) ||
      data.total_count !== data.workflow_runs.length
    )
      throw Error("Release blocked: incomplete or invalid CI run listing.");
    if (!data.workflow_runs.length)
      throw Error(
        `Release blocked: No CI run found for exact commit ${sha} on main. Run main CI first.`,
      );
    data.workflow_runs.forEach(identity);
    if (
      new Set(data.workflow_runs.map((r) => r.id)).size !==
      data.workflow_runs.length
    )
      throw Error("Release blocked: ambiguous CI run listing.");
    return data.workflow_runs.reduce((a, b) => (a.id > b.id ? a : b));
  }
  const selected = await latest();
  successful(selected);
  const detail = await request(`${base}/runs/${selected.id}`);
  successful(detail);
  const current = await latest();
  successful(current);
  for (const run of [detail, current]) {
    if (
      run.id !== selected.id ||
      run.run_attempt !== selected.run_attempt ||
      run.workflow_id !== selected.workflow_id
    )
      throw Error(
        "Release blocked: CI changed during verification. Check the latest run before retrying.",
      );
  }
  return { runId: selected.id, attempt: selected.run_attempt, sha };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    versionFromTag(process.env.RELEASE_TAG);
    const result = await verifyReleaseCI({
      repository: process.env.GITHUB_REPOSITORY,
      sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN,
    });
    console.log(
      `Verified successful CI for exact release commit ${result.sha}: run ${result.runId}, attempt ${result.attempt}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
