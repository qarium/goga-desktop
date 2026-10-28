import { expect, it } from "vitest";
import { gitIntegrationBudget } from "./helpers/git-integration";
import {
  changeFixture,
  fixture,
  fixtureScope,
  races,
  request,
  tree,
} from "./helpers/rebase-conflict-save-fixture";
it.each(races)(
  "rejects %s changes between read and prepare without writes",
  fixtureScope.run(async (change) => {
    const f = await fixture(),
      req = await request(f);
    await changeFixture(f, change);
    const clone = await tree(f.record.path),
      source = await tree(f.root);
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(clone);
    expect(await tree(f.root)).toBe(source);
  }),
  gitIntegrationBudget(45000),
);

it.each([
  "plain detached",
  "wrong reason",
  "wrong branch",
  "malformed",
  "mixed",
  "symlink",
  "hardlink",
  "metadata link",
])(
  "refuses %s despite an earlier readable document",
  fixtureScope.run(async (change) => {
    const f = await fixture(),
      req = await request(f);
    await changeFixture(f, change);
    const clone = await tree(f.record.path),
      source = await tree(f.root);
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "delete" },
      }),
    ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(clone);
    expect(await tree(f.root)).toBe(source);
  }),
  gitIntegrationBudget(45000),
);
