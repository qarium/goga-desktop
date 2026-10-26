import { describe, expect, it } from "vitest";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import { childEnvironment } from "../src/host/process-environment";
describe("trusted host-only Git index scope", () => {
  const index =
    "/private/tmp/repo/.git/goga-commit-12345678-1234-4123-8123-123456789012/index";
  it("admits only the host-created pending merge private index", () => {
    const mergeIndex = index.replace("goga-commit-", "goga-merge-");
    expect(
      withTrustedGitIndex(
        mergeIndex,
        () => childEnvironment({}).GIT_INDEX_FILE,
      ),
    ).toBe(mergeIndex);
    expect(() =>
      withTrustedGitIndex(
        mergeIndex.replace("/index", "/index.lock"),
        () => {},
      ),
    ).toThrow();
    expect(childEnvironment({}).GIT_INDEX_FILE).toBeUndefined();
  });
  it("admits only the host-created abort private index", () => {
    const privateIndex = index.replace("goga-commit-", "goga-abort-");
    expect(
      withTrustedGitIndex(
        privateIndex,
        () => childEnvironment({}).GIT_INDEX_FILE,
      ),
    ).toBe(privateIndex);
  });
  it("strips untrusted inherited/default/override index paths", () => {
    expect(
      childEnvironment(
        { GIT_INDEX_FILE: "/ambient" },
        { GIT_INDEX_FILE: "/default" },
        { GIT_INDEX_FILE: "/override" },
      ).GIT_INDEX_FILE,
    ).toBeUndefined();
  });
  it("isolates concurrent async contexts and cleans up after failure", async () => {
    await Promise.all([
      withTrustedGitIndex(index, async () => {
        await Promise.resolve();
        expect(childEnvironment({}).GIT_INDEX_FILE).toBe(index);
      }),
      (async () => {
        await Promise.resolve();
        expect(childEnvironment({}).GIT_INDEX_FILE).toBeUndefined();
      })(),
    ]);
    await expect(
      withTrustedGitIndex(index, async () => {
        throw Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(childEnvironment({}).GIT_INDEX_FILE).toBeUndefined();
  });
  it("rejects arbitrary, relative and normalized-away paths", () => {
    for (const p of [
      "index",
      "/tmp/index",
      "/tmp/repo/.git/index",
      "/tmp/repo/.git/index.lock",
      `${index}/../index`,
    ])
      expect(() => withTrustedGitIndex(p, () => {})).toThrow();
  });
});
