// Opt-in. Run against a completed local build; no product files are rebuilt or modified.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import electron from "electron";
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const main = await fs.readFile(
  path.join(repo, "dist-electron/index.cjs"),
  "utf8",
);
assert.ok(
  main.includes("GOGA_DEMO_HELPER:") &&
    main.includes("hostTerminal.startPageHint"),
  "Rebuild the Desktop entry, including its isolated demonstration helper",
);
for (const tag of ["en", "ru"]) {
  const { startPageHint } = JSON.parse(
    await fs.readFile(
      path.join(repo, "locales", tag, "hostTerminal.json"),
      "utf8",
    ),
  );
  // esbuild can represent the dictionaries using JS Unicode escapes.
  const decoded = main.replace(/\\u([\da-f]{4})/gi, (_, value) =>
    String.fromCharCode(parseInt(value, 16)),
  );
  assert.ok(
    decoded.includes(startPageHint),
    "Missing bundled helper language: " + tag,
  );
}
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "goga-language-smoke-")),
);
try {
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "goga-language-qa", main: "smoke.cjs" }),
  );
  await fs.copyFile(
    path.join(repo, "scripts/smoke-interface-language.cjs"),
    path.join(root, "smoke.cjs"),
  );
  for (const name of ["dist", "dist-electron"])
    await fs.cp(path.join(repo, name), path.join(root, name), {
      recursive: true,
      filter: (src) => !src.endsWith(".map"),
    });
  for (const name of ["home", "tmp", "profile", "logs", "session", "appdata"])
    await fs.mkdir(path.join(root, name), { mode: 0o700 });
  const home = path.join(root, "home");
  const states = [];
  for (const [start, end] of [
    ["en", "ru"],
    ["ru", "en"],
    ["en", "en"],
  ]) {
    await fs.rm(path.join(root, "result.json"), { force: true });
    const res = spawnSync(
      electron,
      [
        "--use-mock-keychain",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--user-data-dir=" + path.join(root, "profile"),
        root,
      ],
      {
        cwd: root,
        timeout: 30_000,
        killSignal: "SIGKILL",
        encoding: "utf8",
        env: {
          HOME: home,
          CFFIXED_USER_HOME: home,
          TMPDIR: path.join(root, "tmp"),
          PATH: "/usr/bin:/bin",
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          LANG: "ru_RU.UTF-8",
          GOGA_DESKTOP_DATA_DIR: path.join(root, "profile"),
          GOGA_QA_LOCALE_START: start,
          GOGA_QA_LOCALE_END: end,
        },
      },
    );
    const receipt = await fs
      .readFile(path.join(root, "result.json"), "utf8")
      .catch(() => "");
    assert.ok(
      receipt,
      "No smoke result; exit=" +
        res.status +
        " " +
        String(res.error ?? "") +
        " " +
        (res.stderr ?? "").slice(-900),
    );
    const state = JSON.parse(receipt);
    assert.equal(state.ok, true, receipt);
    assert.ifError(res.error);
    assert.equal(res.signal, "SIGKILL");
    states.push(state);
  }
  console.log(JSON.stringify({ passed: true, states }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
