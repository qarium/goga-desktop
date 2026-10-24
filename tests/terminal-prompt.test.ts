import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { prepareTopicPrompt } from "../src/host/terminal-prompt";
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture(topic = "support-afm-hooks", custom = false) {
  const dir = await mkdtemp("/private/tmp/goga-prompt-test-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const root = dir + "/support-afm-hooks-1234567890",
    home = dir + "/home",
    zdot = dir + "/rc";
  for (const p of [root, home, zdot, root + "/nested"]) await mkdir(p);
  await writeFile(
    zdot + "/.zshenv",
    "unsetopt GLOBAL_RCS\nexport FROM_ENV=retained\n",
  );
  await writeFile(zdot + "/.zprofile", "export FROM_PROFILE=retained\n");
  await writeFile(zdot + "/.zlogin", "export FROM_LOGIN=retained\n");
  const rc = custom ? "PROMPT='CUSTOM> '\n" : "PROMPT='%n@%m %1~ %# '\n";
  await writeFile(zdot + "/.zshrc", rc);
  const env = { HOME: home, ZDOTDIR: zdot, PATH: "/usr/bin:/bin" };
  const integration = await prepareTopicPrompt(root, topic, env);
  cleanup.push(integration.dispose);
  const run = (code: string) =>
    execFileSync("/bin/zsh", ["-l", "-i", "-c", code], {
      cwd: root,
      env: { ...env, ZDOTDIR: integration.directory },
      encoding: "utf8",
      timeout: 5000,
    });
  return { dir, root, zdot, rc, integration, run };
}
const update = 'for hook in $precmd_functions; do "$hook"; done;';
it("preserves custom themes, startup files, history location and ZDOTDIR for nested shells", async () => {
  const f = await fixture("topic", true);
  expect(
    f.run(
      `${update} print -P -- "$PROMPT"; print -r -- "$FROM_ENV:$FROM_PROFILE:$FROM_LOGIN:$ZDOTDIR"`,
    ),
  ).toContain(`CUSTOM> \nretained:retained:retained:${f.zdot}`);
  expect(await readFile(f.zdot + "/.zshrc", "utf8")).toBe(f.rc);
  expect((await stat(f.integration.directory)).mode & 0o777).toBe(0o700);
  f.integration.dispose();
  await expect(stat(f.integration.directory)).rejects.toThrow();
});
it("returns from a subdirectory to the abbreviated root and never changes the actual path", async () => {
  const f = await fixture();
  const output = f.run(
    `${update} print -P -- "$PROMPT"; cd nested; ${update} print -P -- "$PROMPT"; cd ..; ${update} print -P -- "$PROMPT"; print -r -- "$PWD"`,
  );
  expect(output.match(/ support-afm-hooks /g)).toHaveLength(2);
  expect(output).toContain(" nested ");
  expect(output).toContain(f.root);
});
it("treats topic text as literal, including percent and shell expansions, and stops when promptsubst is enabled", async () => {
  const f = await fixture("evil%F{red}$(print INJECTED)`print BACKTICK`");
  const first = f.run(`${update} print -P -- "$PROMPT"`);
  expect(first).toContain("evil%F{red}$(print INJECTED)`print BACKTICK`");
  const changed = f.run(
    `${update} setopt promptsubst; ${update} print -P -- "$PROMPT"`,
  );
  expect(changed).not.toContain("INJECTED");
  expect(changed).not.toContain("BACKTICK");
});
