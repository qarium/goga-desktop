import { expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import * as adapter from "../src/main/file-clipboard";
const create = (adapter as any).createFileClipboard;
function fixture(
  items: { types: string[]; getType: (t: string) => Promise<Blob> }[] = [],
) {
  expect(create).toBeTypeOf("function");
  const transport = {
    read: vi.fn(async () => items),
    write: vi.fn(async (_v: unknown[]) => {}),
  };
  const factory = vi.fn((data: Record<string, Blob>) => ({ data }));
  return { transport, factory, clipboard: create(transport, factory) };
}
it("writes multiple files as ONE text/uri-list ClipboardItem, preserving Unicode/spaces/percent", async () => {
  const f = fixture();
  const files = ["/private/tmp/a b/файл%name", "/private/tmp/folder/next"];
  await f.clipboard.writeFiles(files);
  expect(f.factory).toHaveBeenCalledOnce();
  const data = f.factory.mock.calls[0][0];
  expect(Object.keys(data)).toEqual(["text/uri-list"]);
  expect(await data["text/uri-list"].text()).toBe(
    files.map((p) => pathToFileURL(p).href).join("\r\n"),
  );
  expect(f.transport.write).toHaveBeenCalledExactlyOnceWith([{ data }]);
  expect(f.transport.read).not.toHaveBeenCalled();
});
it("reads Finder's aggregate text/uri-list and ignores plain text paths", async () => {
  const getType = vi.fn(
    async () =>
      new Blob([
        "# copied files\r\nfile:///private/tmp/a%20b\r\nfile:///private/tmp/%D1%8F%25\r\n",
      ]),
  );
  const f = fixture([
    {
      types: ["text/plain"],
      getType: vi.fn(async () => new Blob(["/etc/passwd"])),
    },
    { types: ["text/uri-list"], getType },
  ]);
  expect(await f.clipboard.readFiles()).toEqual([
    "/private/tmp/a b",
    "/private/tmp/я%",
  ]);
  expect(getType).toHaveBeenCalledExactlyOnceWith("text/uri-list");
});
it.each([
  "https://example.com/file",
  "file://server/share/a",
  "file:///private/tmp/a?query=1",
  "file:///private/tmp/a#fragment",
  "/private/tmp/text",
  "file:///private/tmp/%00bad",
  "file:///private/tmp/bad%ZZ",
])("rejects a non-local or invalid file URI: %s", async (value) => {
  const f = fixture([
    { types: ["text/uri-list"], getType: async () => new Blob([value]) },
  ]);
  await expect(f.clipboard.readFiles()).rejects.toThrow();
});
it("never reads fallback raw formats or guesses filenames from text", async () => {
  const getType = vi.fn(async () => new Blob(["/private/tmp/a"]));
  const f = fixture([
    {
      types: [
        "text/plain",
        "electron application/osclipboard;format=public.file-url",
      ],
      getType,
    },
  ]);
  expect(await f.clipboard.readFiles()).toEqual([]);
  expect(getType).not.toHaveBeenCalled();
});
it("bounds clipboard data and selection count before decoding or writing", async () => {
  const f = fixture([
    {
      types: ["text/uri-list"],
      getType: async () => new Blob(["x".repeat(1024 * 1024 + 1)]),
    },
  ]);
  await expect(f.clipboard.readFiles()).rejects.toThrow();
  await expect(
    f.clipboard.writeFiles(
      Array.from({ length: 129 }, (_, i) => "/private/tmp/" + i),
    ),
  ).rejects.toThrow();
  expect(f.transport.write).not.toHaveBeenCalled();
});
it("writes path text as fixed text/plain without reading clipboard or permissions", async () => {
  const f = fixture();
  await f.clipboard.writeText("src/a\nпапка/b");
  expect(f.transport.read).not.toHaveBeenCalled();
  const data = f.factory.mock.calls[0][0];
  expect(Object.keys(data)).toEqual(["text/plain"]);
  expect(data["text/plain"].type).toBe("text/plain");
  expect(await data["text/plain"].text()).toBe("src/a\nпапка/b");
});
it("preserves every aggregate and native item while deduplicating repeated URLs", async () => {
  const f = fixture([
    {
      types: ["text/uri-list", "text/plain"],
      getType: async () =>
        new Blob(["file:///private/tmp/a\r\nfile:///private/tmp/b\r\n"]),
    },
    {
      types: ["text/uri-list"],
      getType: async () =>
        new Blob([
          "file:///private/tmp/c\nfile:///private/tmp/d\nfile:///private/tmp/a",
        ]),
    },
  ]);
  expect(await f.clipboard.readFiles()).toEqual([
    "/private/tmp/a",
    "/private/tmp/b",
    "/private/tmp/c",
    "/private/tmp/d",
  ]);
});
it("rejects malformed clipboard payloads instead of trusting blob-like values", async () => {
  const f = fixture([
    {
      types: ["text/uri-list"],
      getType: async () =>
        ({ size: 1, text: async () => "file:///private/tmp/a" }) as any,
    },
  ]);
  await expect(f.clipboard.readFiles()).rejects.toThrow();
});
