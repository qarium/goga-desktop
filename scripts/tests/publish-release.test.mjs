import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  unlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  createManifest,
  inspectArtifacts,
  publishRelease,
} from "../publish-release.mjs";
const sha = "a".repeat(40),
  tag = "v1.2.3-rc.1";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "goga-publisher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["arm64", "x64"].map((a) => `Goga-Desktop-1.2.3-rc.1-${a}.dmg`);
  for (const name of names) await writeFile(path.join(directory, name), name);
  return { directory, names };
}
function mock({
  existing = false,
  annotated = false,
  wrongSha = false,
  badDigest = false,
  badSize = false,
  extraAsset = false,
  changedDraft = false,
  failAt = "",
  duplicateTag = false,
} = {}) {
  const calls = [],
    assets = [];
  let releaseReads = 0;
  const release = {
    id: 12,
    tag_name: tag,
    draft: true,
    prerelease: true,
    target_commitish: sha,
  };
  const transport = async (url, options = {}) => {
    const method = options.method || "GET",
      u = new URL(url),
      route = u.pathname;
    calls.push({ method, route, body: options.body });
    assert.ok(["api.github.com", "uploads.github.com"].includes(u.hostname));
    assert.equal(options.redirect, "error");
    if (failAt && route.endsWith(failAt))
      return { ok: false, status: 500, json: async () => ({}) };
    let value;
    if (route.includes("/git/ref/tags/"))
      value = {
        object: {
          type: annotated ? "tag" : "commit",
          sha: wrongSha ? "b".repeat(40) : sha,
        },
      };
    else if (route.includes("/git/tags/"))
      value = { object: { type: "commit", sha } };
    else if (route.endsWith("/releases") && method === "GET")
      value = existing ? [{ ...release, draft: duplicateTag }] : [];
    else if (route.endsWith("/releases") && method === "POST") value = release;
    else if (u.hostname === "uploads.github.com") {
      const name = u.searchParams.get("name");
      assets.push({
        name,
        size: options.body.length,
        digest: `sha256:${hash(options.body)}`,
      });
      value = assets.at(-1);
    } else if (route.endsWith("/assets")) {
      value = structuredClone(assets);
      if (badDigest) value[0].digest = "sha256:" + "0".repeat(64);
      if (badSize) value[0].size++;
      if (extraAsset) value.push({ name: "debug.log", size: 1, digest: "" });
    } else if (route.endsWith("/releases/12") && method === "GET") {
      releaseReads++;
      value = { ...release, draft: changedDraft ? false : true };
    } else if (route.endsWith("/releases/12") && method === "PATCH")
      value = { ...release, draft: false };
    else throw Error(`Unexpected request ${method} ${url}`);
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, transport, assets };
}
async function prepared(t) {
  const f = await fixture(t);
  await createManifest(f.directory, tag);
  return f;
}
async function publish(f, m, overrides = {}) {
  return publishRelease({
    directory: f.directory,
    tag,
    sha,
    repository: "qarium/goga-desktop",
    token: "fake",
    transport: m.transport,
    ...overrides,
  });
}
test("manifest contains exact canonical two-architecture checksums", async (t) => {
  const f = await prepared(t),
    files = await inspectArtifacts(f.directory, tag);
  assert.deepEqual(
    files.map((f) => f.name),
    [...f.names, "SHA256SUMS"],
  );
  assert.equal(
    await readFile(path.join(f.directory, "SHA256SUMS"), "utf8"),
    f.names.map((n) => `${hash(n)}  ${n}\n`).join(""),
  );
  await assert.rejects(createManifest(f.directory, tag));
});
for (const defect of [
  "missing",
  "extra",
  "symlink",
  "empty",
  "tampered",
  "manifest",
  "wrongTag",
])
  test(`reject local ${defect} before network`, async (t) => {
    const f = await prepared(t),
      m = mock();
    if (defect === "missing") await unlink(path.join(f.directory, f.names[0]));
    if (defect === "extra")
      await writeFile(path.join(f.directory, "debug.log"), "debug");
    if (defect === "symlink") {
      await unlink(path.join(f.directory, f.names[0]));
      await symlink(f.names[1], path.join(f.directory, f.names[0]));
    }
    if (defect === "empty")
      await writeFile(path.join(f.directory, f.names[0]), "");
    if (defect === "tampered")
      await writeFile(path.join(f.directory, f.names[0]), "changed");
    if (defect === "manifest")
      await writeFile(path.join(f.directory, "SHA256SUMS"), "invalid");
    await assert.rejects(
      publish(f, m, defect === "wrongTag" ? { tag: "v1.2.03" } : {}),
    );
    assert.equal(m.calls.length, 0);
  });
for (const overrides of [
  { repository: "other/repo" },
  { sha: "main" },
  { token: "" },
])
  test(`reject invalid publishing identity ${JSON.stringify(overrides)}`, async (t) => {
    const f = await prepared(t),
      m = mock();
    await assert.rejects(publish(f, m, overrides));
    assert.equal(m.calls.length, 0);
  });
for (const options of [
  { existing: true },
  { existing: true, duplicateTag: true },
  { wrongSha: true },
])
  test(`refuse existing release or wrong remote commit ${JSON.stringify(options)}`, async (t) => {
    const f = await prepared(t),
      m = mock(options);
    await assert.rejects(publish(f, m));
    assert.ok(m.calls.every((c) => c.method === "GET"));
  });
for (const options of [
  { badDigest: true },
  { badSize: true },
  { extraAsset: true },
  { changedDraft: true },
  { failAt: "/assets" },
  { failAt: "/releases" },
])
  test(`fail closed without publishing ${JSON.stringify(options)}`, async (t) => {
    const f = await prepared(t),
      m = mock(options);
    await assert.rejects(publish(f, m));
    assert.ok(m.calls.every((c) => c.method !== "PATCH"));
  });
for (const annotated of [false, true])
  test(`publish verified draft last; annotated=${annotated}`, async (t) => {
    const f = await prepared(t),
      m = mock({ annotated });
    await publish(f, m);
    const create = m.calls.find(
      (c) => c.method === "POST" && c.route.endsWith("/releases"),
    );
    assert.deepEqual(JSON.parse(create.body), {
      tag_name: tag,
      target_commitish: sha,
      name: tag,
      draft: true,
      prerelease: true,
      body: "Artifacts: macOS arm64 and x64. Ad-hoc signed, without Developer ID or Apple notarization. Gatekeeper may block downloaded apps. Native build/runtime and isolated UI checks are not clean-Mac installation tests; installation of downloads from GitHub Releases has not been verified. Verify downloaded files against SHA256SUMS.",
    });
    assert.deepEqual(
      m.assets.map((a) => a.name),
      [...f.names, "SHA256SUMS"],
    );
    assert.equal(m.calls.at(-1).method, "PATCH");
    assert.equal(m.calls.at(-2).method, "GET");
    assert.equal(
      m.calls.at(-2).route,
      "/repos/qarium/goga-desktop/releases/12",
    );
    assert.deepEqual(JSON.parse(m.calls.at(-1).body), { draft: false });
  });

for (const defect of [
  { draft: "true" },
  { target_commitish: "b".repeat(40) },
  { prerelease: false },
])
  test(`reject unexpected draft response before uploads ${JSON.stringify(defect)}`, async (t) => {
    const f = await prepared(t),
      m = mock(),
      original = m.transport;
    m.transport = async (url, options) => {
      const response = await original(url, options);
      if (
        options.method === "POST" &&
        new URL(url).pathname.endsWith("/releases")
      )
        return {
          ...response,
          json: async () => ({ ...(await response.json()), ...defect }),
        };
      return response;
    };
    await assert.rejects(publish(f, m));
    assert.equal(m.assets.length, 0);
    assert.ok(m.calls.every((c) => c.method !== "PATCH"));
  });
for (const defect of [
  "missing digest",
  "missing asset",
  "duplicate name",
  "wrong name",
  "missing remote tag",
  "tag moved before draft",
  "tag moved after uploads",
])
  test(`refuse ${defect}`, async (t) => {
    const f = await prepared(t),
      m = mock(),
      original = m.transport;
    let refs = 0;
    m.transport = async (url, options) => {
      const response = await original(url, options),
        route = new URL(url).pathname;
      if (route.includes("/git/ref/tags/")) {
        refs++;
        if (defect === "missing remote tag") return { ok: false, status: 404 };
        if (
          (defect === "tag moved before draft" && refs === 2) ||
          (defect === "tag moved after uploads" && refs === 3)
        )
          return {
            ...response,
            json: async () => ({
              object: { type: "commit", sha: "b".repeat(40) },
            }),
          };
      }
      if (route.endsWith("/assets") && options.method === "GET") {
        const assets = await response.json();
        if (defect === "missing digest") delete assets[0].digest;
        if (defect === "missing asset") assets.pop();
        if (defect === "duplicate name") assets[0].name = assets[1].name;
        if (defect === "wrong name") assets[0].name = "unexpected.dmg";
        return { ...response, json: async () => assets };
      }
      return response;
    };
    await assert.rejects(publish(f, m));
    assert.ok(m.calls.every((c) => c.method !== "PATCH"));
    if (defect === "missing remote tag" || defect === "tag moved before draft")
      assert.ok(m.calls.every((c) => c.method === "GET"));
  });
test("stable tag creates a non-prerelease draft", async (t) => {
  const f = await fixture(t),
    stable = "v1.2.3";
  const { rename } = await import("node:fs/promises");
  for (const name of f.names)
    await rename(
      path.join(f.directory, name),
      path.join(f.directory, name.replace("-rc.1", "")),
    );
  await createManifest(f.directory, stable);
  const m = mock(),
    original = m.transport;
  m.transport = async (url, options) => {
    const r = await original(url, options);
    const v = await r.json();
    if (v && !Array.isArray(v) && v.tag_name) {
      v.tag_name = stable;
      v.prerelease = false;
    }
    return { ...r, json: async () => v };
  };
  await publish(f, m, { tag: stable });
  assert.equal(
    JSON.parse(
      m.calls.find((c) => c.method === "POST" && c.route.endsWith("/releases"))
        .body,
    ).prerelease,
    false,
  );
});
