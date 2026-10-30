import { describe, expect, it, vi } from "vitest";
import type { Runner } from "../src/host/process";
import { CommandExitError } from "../src/host/process";
import { readSignal, withReadScope } from "../src/host/read-scope";
import {
  readOverviewContract,
  readOverviewSchema,
} from "../src/host/project-overview-architecture";
import {
  buildArchitectureIndex,
  isNavigableArchitecturePath,
  OVERVIEW_ARCHITECTURE_LIMITS,
  type SchemaCell,
} from "../src/shared/project-architecture";

const root = "/private/tmp/synthetic-overview-project";
const executable = "/private/tmp/synthetic-tools/goga";
function cell(
  name = "src/core",
  changes: Partial<SchemaCell> = {},
): SchemaCell {
  return {
    cell: name,
    description: "Полное описание\nс переносом строки.",
    types: ["Entity", "run"],
    usages: ["README.md"],
    dependencies: {},
    children: [],
    ...changes,
  };
}
function runnerFor(stdout: string, stderr = ""): Runner {
  return {
    command: vi.fn(async () => ({ stdout, stderr })),
    start: () => {
      throw Error("Tests must never launch a process");
    },
    kill: () => {
      throw Error("Tests must never own a real process");
    },
  };
}
const schemaRunner = (value: unknown) => runnerFor(JSON.stringify(value));
const contractRunner = (value: unknown, name = "src/core") =>
  schemaRunner({ [name]: value });
const readSchema = (value: unknown) =>
  readOverviewSchema(schemaRunner(value), executable, root);
const readContract = (value: unknown) =>
  readOverviewContract(contractRunner(value), executable, root, "src/core");

describe("overview architecture command adapter", () => {
  it("reads an empty public schema without extra commands or stderr parsing", async () => {
    const runner = runnerFor("[]", "Plugin summary: not JSON\n");
    expect(await readOverviewSchema(runner, executable, root)).toEqual([]);
    expect(runner.command).toHaveBeenCalledExactlyOnceWith(
      executable,
      ["schema"],
      root,
    );
  });

  it("uses the exact supplied topic cwd and retains complete multiple-root data", async () => {
    const description = "Описание с переносом.\n".repeat(400);
    const fixture = [
      cell(".", { description, children: [cell()] }),
      cell("other"),
    ];
    const runner = schemaRunner(fixture);
    const topicRoot = `${root}/topic-copy`;
    expect(await readOverviewSchema(runner, executable, topicRoot)).toEqual(
      fixture,
    );
    expect(runner.command).toHaveBeenCalledExactlyOnceWith(
      executable,
      ["schema"],
      topicRoot,
    );
  });

  it("passes resolved project environment only to the process boundary", async () => {
    const env = {
      HOME: "/private/tmp/synthetic-home",
      PROJECT_SETTING: "fixture",
    };
    const schema = schemaRunner([]);
    const contract = contractRunner({});
    expect(await readOverviewSchema(schema, executable, root, env)).toEqual([]);
    expect(
      await readOverviewContract(contract, executable, root, "src/core", env),
    ).toEqual({});
    expect(schema.command).toHaveBeenCalledExactlyOnceWith(
      executable,
      ["schema"],
      root,
      env,
    );
    expect(contract.command).toHaveBeenCalledExactlyOnceWith(
      executable,
      ["contract", "--", "src/core"],
      root,
      env,
    );
  });

  it("tolerates future schema/tool fields without interpreting or forwarding them", async () => {
    const fixture = cell("src/core", {
      dependencies: { "src/util": { types: ["Util"], usages: [] } },
    });
    const extended = {
      ...fixture,
      tools: { example: { arbitrary: [1, true, { nested: "fact" }] } },
      future: { any: "shape" },
      dependencies: {
        "src/util": { ...fixture.dependencies["src/util"], future: 1 },
      },
    };
    expect(await readSchema([extended])).toEqual([fixture]);
  });

  it.each([
    ["non-array", {}],
    ["missing children", [{ ...cell(), children: undefined }]],
    ["invalid description", [{ ...cell(), description: null }]],
    ["invalid types", [{ ...cell(), types: [1] }]],
    ["invalid usage", [{ ...cell(), usages: "README.md" }]],
    [
      "invalid dependencies",
      [{ ...cell(), dependencies: { other: { types: [] } } }],
    ],
    ["unsafe cell path", [cell("../outside")]],
    ["duplicate paths", [cell(), cell()]],
  ])("rejects an invalid public schema: %s", async (_name, fixture) => {
    await expect(readSchema(fixture)).rejects.toThrow(/схем|пут|лимит/i);
  });

  it("rejects malformed JSON without exposing raw stdout or stderr", async () => {
    const runner = runnerFor(
      "PRIVATE_BROKEN_JSON",
      "PRIVATE_PLUGIN_DIAGNOSTIC",
    );
    await expect(readOverviewSchema(runner, executable, root)).rejects.toThrow(
      /JSON/,
    );
    await expect(
      readOverviewSchema(runner, executable, root),
    ).rejects.not.toThrow(/PRIVATE/);
  });

  it("does not mistake a CLI failure with JSON-shaped stdout for success", async () => {
    const failure = new CommandExitError(
      "CLI failed",
      2,
      "[]",
      "private detail",
    );
    const runner = runnerFor("[]");
    vi.mocked(runner.command).mockRejectedValue(failure);
    await expect(
      readOverviewSchema(runner, executable, root),
    ).rejects.toMatchObject({
      exitCode: failure.exitCode,
      stdout: failure.stdout,
      stderr: failure.stderr,
      message: "Команда «goga schema» завершилась с кодом 2.",
    });
  });

  it("inherits read cancellation and refuses a late successful response", async () => {
    const controller = new AbortController();
    let finish!: (result: { stdout: string; stderr: string }) => void;
    const runner = runnerFor("[]");
    vi.mocked(runner.command).mockImplementation(async () => {
      expect(readSignal()).toBe(controller.signal);
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = withReadScope(controller.signal, () =>
      readOverviewSchema(runner, executable, root),
    );
    const rejection = expect(result).rejects.toThrow(/отменено/i);
    controller.abort();
    finish?.({ stdout: "[]", stderr: "" });
    await rejection;
  });

  it("does not start a command in an already-cancelled read scope", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = runnerFor("[]");
    await expect(
      withReadScope(controller.signal, () =>
        readOverviewSchema(runner, executable, root),
      ),
    ).rejects.toThrow(/отменено/i);
    expect(runner.command).not.toHaveBeenCalled();
  });

  it("rejects UTF-8 byte overflow, not merely JavaScript string-length overflow", async () => {
    const text = "я".repeat(
      Math.floor(OVERVIEW_ARCHITECTURE_LIMITS.outputBytes / 2),
    );
    await expect(
      readSchema([cell("src/core", { description: text })]),
    ).rejects.toThrow(/лимит|больш/i);
  });

  it("rejects excessive tree depth before recursive validation can overflow", async () => {
    let fixture = cell("a".repeat(OVERVIEW_ARCHITECTURE_LIMITS.depth + 2));
    for (let depth = OVERVIEW_ARCHITECTURE_LIMITS.depth + 1; depth > 0; depth--)
      fixture = cell("a".repeat(depth), { children: [fixture] });
    await expect(readSchema([fixture])).rejects.toThrow(/глубин|лимит/i);
  });

  it("rejects excessive cell count instead of returning a silently partial index", async () => {
    const fixture = Array.from(
      { length: OVERVIEW_ARCHITECTURE_LIMITS.cells + 1 },
      (_, i) => cell(`cell-${i}`),
    );
    await expect(readSchema(fixture)).rejects.toThrow(/лимит|больш/i);
  });
});

describe("public contract comparison data", () => {
  it("unwraps exactly the selected cell and sends its argument without shell evaluation", async () => {
    const name = "src/cell $(not-a-command); --flag";
    const types = {
      run: {
        signature: { codemanifest: "  fn() -> None\r\n", implementation: null },
      },
    };
    const runner = contractRunner(types, name);
    expect(await readOverviewContract(runner, executable, root, name)).toEqual(
      types,
    );
    expect(runner.command).toHaveBeenCalledExactlyOnceWith(
      executable,
      ["contract", "--", name],
      root,
    );
  });

  it("allows the root cell and option-shaped relative names after --", async () => {
    for (const name of [".", "--lang=not-an-option"]) {
      const runner = contractRunner({}, name);
      expect(
        await readOverviewContract(runner, executable, root, name),
      ).toEqual({});
      expect(runner.command).toHaveBeenCalledExactlyOnceWith(
        executable,
        ["contract", "--", name],
        root,
      );
    }
  });

  it("preserves every raw language string, null, whitespace, member name and Unicode character", async () => {
    const languages = [
      "func (s *Store) Read[T any](ctx context.Context) (T, error)",
      "async function run<T extends A<B>>(x: T): Promise<T | null>",
      "def run(x: list[tuple[str, int]] = []) -> Any:",
      "suspend inline fun <reified T> run(x: T?): Result<T>",
      "public func run<T>(_ value: T) async throws -> T?",
      "\ufeff  странная 🔬 сигнатура\r\n\tбез разбора = < > | ? ()\u0000",
    ];
    const fixture = Object.fromEntries(
      languages.map((signature, index) => [
        `Raw type ${index}`,
        {
          signature: {
            codemanifest: signature,
            implementation: index % 2 ? signature + " " : null,
          },
          properties: {
            "property with spaces": {
              codemanifest: null,
              implementation: signature,
            },
          },
          methods: {
            "<init>": { codemanifest: signature, implementation: null },
          },
        },
      ]),
    );
    expect(await readContract(fixture)).toEqual(fixture);
  });

  it("permits empty/optional comparison sections and strips unknown tool fields", async () => {
    const fixture = {
      Empty: {},
      Entity: {
        signature: { codemanifest: "", implementation: null },
        properties: {},
        methods: {},
      },
    };
    const extended = {
      Empty: { future: "ignored" },
      Entity: {
        ...fixture.Entity,
        tools: { arbitrary: [true, 5] },
        signature: { ...fixture.Entity.signature, future: "ignored" },
      },
    };
    expect(await readContract(extended)).toEqual(fixture);
  });

  it.each([
    ["not an object", []],
    ["not a pair", { run: { signature: "run()" } }],
    [
      "missing implementation",
      { run: { signature: { codemanifest: "run()" } } },
    ],
    [
      "non-string codemanifest",
      { run: { signature: { codemanifest: 4, implementation: null } } },
    ],
    [
      "non-string implementation",
      { run: { methods: { run: { codemanifest: null, implementation: [] } } } },
    ],
    ["non-object members", { run: { properties: [] } }],
  ])("rejects an invalid public contract: %s", async (_name, fixture) => {
    await expect(readContract(fixture)).rejects.toThrow(/контракт/i);
  });

  it("does not accept another cell's envelope or an unwrapped type record", async () => {
    for (const fixture of [
      { other: {} },
      { run: { signature: { codemanifest: "run()", implementation: null } } },
    ])
      await expect(
        readOverviewContract(
          schemaRunner(fixture),
          executable,
          root,
          "src/core",
        ),
      ).rejects.toThrow(/контракт|ячейк|пут/i);
  });

  it("does not publish a late contract after cancellation", async () => {
    const controller = new AbortController();
    const runner = contractRunner({});
    vi.mocked(runner.command).mockImplementation(async () => {
      controller.abort();
      return { stdout: '{"src/core":{}}', stderr: "" };
    });
    await expect(
      withReadScope(controller.signal, () =>
        readOverviewContract(runner, executable, root, "src/core"),
      ),
    ).rejects.toThrow(/отменено/i);
  });

  it.each([
    "",
    "../outside",
    "src/../outside",
    "/absolute",
    "C:\\outside",
    "src\\core",
    "src//core",
    "src/./core",
    "src/",
    ".git",
    "nested/.GiT/data",
    "src/\u0000cell",
    "src/\ncell",
  ])(
    "refuses unsafe contract path %j before invoking the runner",
    async (name) => {
      const runner = contractRunner({}, name);
      await expect(
        readOverviewContract(runner, executable, root, name),
      ).rejects.toThrow(/пут/i);
      expect(runner.command).not.toHaveBeenCalled();
    },
  );

  it("bounds the requested path length before invoking the runner", async () => {
    const name = "a".repeat(OVERVIEW_ARCHITECTURE_LIMITS.pathLength + 1);
    const runner = contractRunner({}, name);
    await expect(
      readOverviewContract(runner, executable, root, name),
    ).rejects.toThrow(/пут/i);
    expect(runner.command).not.toHaveBeenCalled();
  });
});

describe("plain schema index", () => {
  it("indexes multiple levels without making hierarchy edges or expanding dependency cycles", async () => {
    const fixture = [
      cell("src", {
        children: [
          cell("src/core", {
            dependencies: {
              "src/util": { types: ["Util"], usages: ["util.md"] },
            },
          }),
        ],
      }),
      cell("src/util", {
        dependencies: { "src/core": { types: ["Core"], usages: [] } },
      }),
    ];
    const parsed = await readSchema(fixture);
    const index = buildArchitectureIndex(parsed);
    expect(index.roots).toEqual(["src", "src/util"]);
    expect(Object.keys(index.cells)).toEqual(["src", "src/core", "src/util"]);
    expect(index.parents).toEqual({
      src: null,
      "src/core": "src",
      "src/util": null,
    });
    expect(index.edges).toEqual([
      {
        source: "src/core",
        target: "src/util",
        types: ["Util"],
        usages: ["util.md"],
        navigable: true,
      },
      {
        source: "src/util",
        target: "src/core",
        types: ["Core"],
        usages: [],
        navigable: true,
      },
    ]);
    expect(fixture[0].children).toEqual(parsed[0].children);
    expect(JSON.parse(JSON.stringify(index))).toEqual(index);
  });

  it("keeps outside/missing dependencies visible, but never gives them navigation authority", async () => {
    const dependency = { types: ["External"], usages: ["reference.md"] };
    const names = [
      "../outside",
      "/private/tmp/other-project",
      "C:\\outside",
      "src/missing",
      ".git/data",
    ];
    const fixture = [
      cell("src", {
        dependencies: Object.fromEntries(
          names.map((name) => [name, dependency]),
        ),
      }),
    ];
    const index = buildArchitectureIndex(await readSchema(fixture));
    expect(index.edges).toEqual(
      names.map((target) => ({
        source: "src",
        target,
        ...dependency,
        navigable: false,
      })),
    );
    expect(Object.keys(index.cells)).toEqual(["src"]);
    for (const name of names.filter((name) => name !== "src/missing"))
      expect(isNavigableArchitecturePath(name)).toBe(false);
    expect(isNavigableArchitecturePath(".")).toBe(true);
  });

  it("keeps special object keys as data without prototype navigation or pollution", async () => {
    const dependencies = JSON.parse(
      '{"__proto__":{"types":[],"usages":[]},"toString":{"types":[],"usages":[]}}',
    );
    const index = buildArchitectureIndex(
      await readSchema([cell("constructor", { dependencies })]),
    );
    expect(index.cells.constructor).toEqual(
      cell("constructor", { dependencies }),
    );
    expect(index.edges).toEqual([
      {
        source: "constructor",
        target: "__proto__",
        types: [],
        usages: [],
        navigable: false,
      },
      {
        source: "constructor",
        target: "toString",
        types: [],
        usages: [],
        navigable: false,
      },
    ]);
    expect(Object.getPrototypeOf(index.cells)).toBeNull();
    expect(Object.getPrototypeOf(index.parents)).toBeNull();
  });
});

describe("overview process error context", () => {
  it.each(["schema", "contract"])(
    "names the failing %s command and code without publishing process streams",
    async (command) => {
      const failure = new CommandExitError(
        "Команда завершилась с кодом 1. Проверьте Goga, Docker и конфигурацию проекта.",
        1,
        "PRIVATE_STDOUT",
        "PRIVATE_STDERR",
      );
      const runner = runnerFor("");
      vi.mocked(runner.command).mockRejectedValue(failure);
      try {
        if (command === "schema")
          await readOverviewSchema(runner, executable, root);
        else await readOverviewContract(runner, executable, root, "src/core");
        expect.fail("Expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(CommandExitError);
        expect((error as CommandExitError).exitCode).toBe(1);
        expect((error as Error).message).toContain("goga " + command);
        expect((error as Error).message).toContain("кодом 1");
        expect((error as Error).message).not.toMatch(
          /PRIVATE|Docker|remote method/,
        );
        expect((error as CommandExitError).stdout).toBe("PRIVATE_STDOUT");
        expect((error as CommandExitError).stderr).toBe("PRIVATE_STDERR");
      }
    },
  );
});

it("preserves lifecycle failures and reports a cancelled read instead of a late command exit", async () => {
  const runner = runnerFor("");
  const lifecycle = Error(
    "Команда не ответила вовремя. Проверьте Goga / Docker.",
  );
  vi.mocked(runner.command).mockRejectedValueOnce(lifecycle);
  await expect(readOverviewSchema(runner, executable, root)).rejects.toBe(
    lifecycle,
  );
  const controller = new AbortController();
  vi.mocked(runner.command).mockImplementationOnce(async () => {
    controller.abort();
    throw new CommandExitError(
      "Command ended after cancellation",
      1,
      "PRIVATE",
      "PRIVATE",
    );
  });
  await expect(
    withReadScope(controller.signal, () =>
      readOverviewSchema(runner, executable, root),
    ),
  ).rejects.toThrow(/отменено/);
});
it("names a signalled schema process and quotes the actual wrapper/contract path without exposing environment", async () => {
  const runner = runnerFor("");
  vi.mocked(runner.command).mockRejectedValue(
    new CommandExitError("signal", null, "PRIVATE", "PRIVATE"),
  );
  await expect(readOverviewSchema(runner, executable, root)).rejects.toThrow(
    "Команда «goga schema» прервана сигналом.",
  );
  await expect(
    readOverviewContract(
      runner,
      "/tmp/test tools/goga wrapper",
      root,
      "src/my cell",
      { TOKEN: "PRIVATE_TOKEN" },
    ),
  ).rejects.toThrow(
    'Команда «"goga wrapper" contract -- "src/my cell"» прервана сигналом.',
  );
});
