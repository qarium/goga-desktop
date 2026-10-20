import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { versionFromTag } from "./release-version.mjs";

const repositoryName = "qarium/goga-desktop";
const digest = (data) => createHash("sha256").update(data).digest("hex");
export function artifactNames(tag) {
  const version = versionFromTag(tag);
  return ["arm64", "x64"].map((arch) => `Goga-Desktop-${version}-${arch}.dmg`);
}
async function readArtifacts(directory, names) {
  if (!(await lstat(directory)).isDirectory())
    throw Error("Artifact directory must not be a symlink");
  const actual = (await readdir(directory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names].sort()))
    throw Error("Unexpected, missing or extra release files");
  return Promise.all(
    names.map(async (name) => {
      const filename = path.join(directory, name),
        stat = await lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0)
        throw Error(`Not a nonempty regular single-link file: ${name}`);
      const data = await readFile(filename);
      if (data.length !== stat.size)
        throw Error(`File changed while reading: ${name}`);
      return {
        name,
        data,
        size: data.length,
        digest: `sha256:${digest(data)}`,
      };
    }),
  );
}
function manifestText(files) {
  return files.map((f) => `${f.digest.slice(7)}  ${f.name}\n`).join("");
}
export async function createManifest(directory, tag) {
  const files = await readArtifacts(directory, artifactNames(tag));
  await writeFile(path.join(directory, "SHA256SUMS"), manifestText(files), {
    flag: "wx",
  });
}
export async function inspectArtifacts(directory, tag) {
  const files = await readArtifacts(directory, [
    ...artifactNames(tag),
    "SHA256SUMS",
  ]);
  if (files.at(-1).data.toString("utf8") !== manifestText(files.slice(0, 2)))
    throw Error("SHA256SUMS mismatch");
  return files;
}

/** The injectable transport is for offline tests; all production URLs remain fixed. */
export async function publishRelease({
  directory,
  tag,
  sha,
  repository,
  token,
  transport = fetch,
}) {
  versionFromTag(tag);
  if (
    repository !== repositoryName ||
    !/^[a-f0-9]{40}$/.test(sha ?? "") ||
    !token
  )
    throw Error("Invalid release repository, commit or token");
  // Read once: immutable byte buffers, not reopened paths, are uploaded after validation.
  const files = await inspectArtifacts(directory, tag);
  const base = `https://api.github.com/repos/${repositoryName}`;
  async function request(url, method = "GET", body, binary = false) {
    const host = new URL(url).hostname;
    if (!["api.github.com", "uploads.github.com"].includes(host))
      throw Error("Disallowed API host");
    const response = await transport(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined
          ? {}
          : {
              "Content-Type": binary
                ? "application/octet-stream"
                : "application/json",
            }),
      },
      ...(body === undefined
        ? {}
        : { body: binary ? body : JSON.stringify(body) }),
    });
    if (!response.ok)
      throw Error(
        `GitHub API ${method} failed (${response.status}); recover drafts manually`,
      );
    return response.json();
  }
  async function verifyTag() {
    let { object } = await request(
      `${base}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
    for (let depth = 0; object?.type === "tag"; depth++) {
      if (depth >= 10 || !/^[a-f0-9]{40}$/.test(object.sha))
        throw Error("Invalid annotated tag chain");
      ({ object } = await request(`${base}/git/tags/${object.sha}`));
    }
    if (object?.type !== "commit" || object.sha !== sha)
      throw Error("Remote tag does not resolve to the expected commit");
  }
  await verifyTag();
  // Listing includes authenticated drafts; fail closed rather than deleting/replacing.
  for (let page = 1; ; page++) {
    if (page > 100) throw Error("Release listing limit exceeded");
    const releases = await request(
      `${base}/releases?per_page=100&page=${page}`,
    );
    if (!Array.isArray(releases)) throw Error("Invalid release listing");
    if (releases.some((r) => r.tag_name === tag))
      throw Error("Release already exists; manual recovery required");
    if (releases.length < 100) break;
  }
  // Check again immediately before creation; target_commitish is immutable SHA, never a branch.
  await verifyTag();
  const created = await request(`${base}/releases`, "POST", {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    draft: true,
    prerelease: tag.includes("-"),
    body: "Artifacts: macOS arm64 and x64. Ad-hoc signed, without Developer ID or Apple notarization. Gatekeeper may block downloaded apps. Native build/runtime and isolated UI checks are not clean-Mac installation tests; installation of downloads from GitHub Releases has not been verified. Verify downloaded files against SHA256SUMS.",
  });
  if (
    !Number.isSafeInteger(created.id) ||
    created.id <= 0 ||
    created.draft !== true ||
    created.prerelease !== tag.includes("-") ||
    created.target_commitish !== sha ||
    created.tag_name !== tag
  )
    throw Error("Unexpected draft response");
  const releaseURL = `${base}/releases/${created.id}`;
  for (const file of files) {
    await request(
      `https://uploads.github.com/repos/${repositoryName}/releases/${created.id}/assets?name=${encodeURIComponent(file.name)}`,
      "POST",
      file.data,
      true,
    );
  }
  const uploaded = await request(`${releaseURL}/assets?per_page=100`);
  if (!Array.isArray(uploaded) || uploaded.length !== files.length)
    throw Error("Unexpected server asset set");
  for (const file of files) {
    const matches = uploaded.filter((a) => a.name === file.name);
    if (
      matches.length !== 1 ||
      matches[0].size !== file.size ||
      matches[0].digest !== file.digest
    )
      throw Error(`Server asset verification failed: ${file.name}`);
  }
  await verifyTag();
  const current = await request(releaseURL);
  if (
    current.id !== created.id ||
    current.draft !== true ||
    current.tag_name !== tag ||
    current.target_commitish !== sha ||
    current.prerelease !== tag.includes("-")
  )
    throw Error("Draft changed before publication");
  const published = await request(releaseURL, "PATCH", { draft: false });
  if (
    published.id !== created.id ||
    published.draft !== false ||
    published.tag_name !== tag
  )
    throw Error("Publication response could not be verified");
  return published;
}
async function main() {
  const [command, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !["manifest", "publish"].includes(command))
    throw Error(
      "Usage: node scripts/publish-release.mjs manifest|publish DIRECTORY",
    );
  if (command === "manifest")
    await createManifest(directory, process.env.RELEASE_TAG);
  else
    await publishRelease({
      directory,
      tag: process.env.RELEASE_TAG,
      sha: process.env.GITHUB_SHA,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
