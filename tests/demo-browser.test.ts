// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { createDemoBrowser } from "../src/main/demo-browser";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/XXUAAAAASUVORK5CYII=",
  "base64",
);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
function fixture() {
  const urls = new Map([
    ["show-secret-a", "http://fixture.invalid/one"],
    ["show-secret-b", "file:///private/forbidden"],
  ]);
  let now = 100000,
    ticket = "";
  const control = vi.fn(async () => {}),
    frame = vi.fn(async (_id: string): Promise<Uint8Array> =>
      Uint8Array.from(png),
    );
  const catalogs = new Map<
    string,
    {
      tabs: { tabId: string; title: string; url: string | null }[];
      activeTabId: string | null;
    }
  >();
  const nextFrame = vi.fn(
    async (
      _id: string,
      _tab: string,
      _after: string | null,
    ): Promise<{ cursor: string; pixels: Uint8Array } | null> => ({
      cursor: "serial-1",
      pixels: Uint8Array.from(png),
    }),
  );
  const service = createDemoBrowser({
    status: async (id) =>
      urls.has(id) ? { url: urls.get(id)!, ...catalogs.get(id) } : null,
    frame,
    nextFrame,
    control,
    openExternal: async (url) => {
      ticket = url;
    },
    now: () => now,
  });
  cleanup.push(service.close);
  const open = async (id = "show-secret-a") => {
    await service.open(id);
    return ticket;
  };
  const claim = async (id = "show-secret-a") => {
    const link = await open(id),
      r = await fetch(link, { redirect: "manual" });
    expect(r.status).toBe(303);
    const header = r.headers.get("set-cookie")!,
      url = new URL(r.headers.get("location")!, link);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=" + url.pathname);
    return { url, cookie: header.split(";")[0], link };
  };
  return {
    urls,
    catalogs,
    open,
    claim,
    control,
    frame,
    nextFrame,
    advance: (ms: number) => (now += ms),
    service,
  };
}
const req = (url: URL, headers: Record<string, string> = {}) =>
  new Promise<number>((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      })
      .on("error", reject);
  });
describe("external show viewer", () => {
  it("redeems a short-lived ticket only once and keeps tokens and project identifiers out of the viewer", async () => {
    const f = fixture(),
      { url, cookie, link } = await f.claim();
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.href).not.toContain("show-secret");
    expect(url.href).not.toBe(link);
    expect((await fetch(link)).status).toBe(403);
    const response = await fetch(url, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await response.text();
    expect(html).not.toContain("show-secret");
    expect(html).not.toContain(cookie);
    expect(html).not.toContain(link);
    const pending = await f.open();
    f.advance(65000);
    expect((await fetch(pending)).status).toBe(403);
    await expect(f.open("nonexistent")).rejects.toThrow();
  });
  it("requires the matching session even for frames, rejects forged host and cross-site requests", async () => {
    const f = fixture(),
      a = await f.claim(),
      b = await f.claim("show-secret-b"),
      frame = new URL("frame", a.url);
    expect((await fetch(frame)).status).toBe(403);
    expect((await fetch(frame, { headers: { cookie: b.cookie } })).status).toBe(
      403,
    );
    expect(await req(frame, { cookie: a.cookie, host: "evil.example" })).toBe(
      403,
    );
    expect(
      await req(frame, { cookie: a.cookie, "sec-fetch-site": "cross-site" }),
    ).toBe(403);
    expect(f.frame).not.toHaveBeenCalled();
    const r = await fetch(frame, { headers: { cookie: a.cookie } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(png);
    expect(f.frame).toHaveBeenCalledWith("show-secret-a");
    expect(
      await (
        await fetch(new URL("status", b.url), { headers: { cookie: b.cookie } })
      ).json(),
    ).toEqual({ url: null });
    expect(
      (
        await fetch(new URL("/api/state", a.url), {
          headers: { cookie: a.cookie },
        })
      ).ok,
    ).toBe(false);
  });
  it("streams only from the cookie-bound show, carries an opaque cursor and rejects expired in-flight reads", async () => {
    const f = fixture(),
      { url, cookie } = await f.claim(),
      other = await f.claim("show-secret-b");
    const next = new URL("next", url);
    const read = (extra: Record<string, string> = {}) =>
      fetch(next, { headers: { cookie, "x-demo-tab": "tab-a", ...extra } });
    expect((await read({ cookie: other.cookie })).status).toBe(403);
    expect((await read({ "x-demo-tab": "../../x" })).status).toBe(400);
    expect((await read({ "x-demo-after": "bad cursor" })).status).toBe(400);
    expect(f.nextFrame).not.toHaveBeenCalled();
    const r = await read();
    expect(r.status).toBe(200);
    expect(r.headers.get("x-demo-cursor")).toBe("serial-1");
    expect(Buffer.from(await r.arrayBuffer())).toEqual(png);
    expect(f.nextFrame).toHaveBeenCalledWith("show-secret-a", "tab-a", null);
    f.nextFrame.mockResolvedValueOnce(null);
    expect((await read({ "x-demo-after": "serial-1" })).status).toBe(204);
    expect(f.nextFrame).toHaveBeenLastCalledWith(
      "show-secret-a",
      "tab-a",
      "serial-1",
    );
    f.nextFrame.mockImplementationOnce(async () => {
      f.advance(5 * 60 * 60 * 1000);
      return { cursor: "late", pixels: png };
    });
    expect((await read()).status).toBe(410);
  });
  it("accepts only allowlisted same-origin gestures for the bound show", async () => {
    const f = fixture(),
      a = await f.claim(),
      target = new URL("control", a.url);
    const send = (body: unknown, origin = a.url.origin) =>
      fetch(target, {
        method: "POST",
        headers: {
          origin,
          cookie: a.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    expect((await send({ op: "reload" }, "http://evil.invalid")).status).toBe(
      403,
    );
    f.catalogs.set("show-secret-a", {
      tabs: [{ tabId: "visible", url: null, title: "A" }],
      activeTabId: "visible",
    });
    for (const op of [
      { op: "input", action: "click", x: 0.75, y: 0.5 },
      { op: "input", tabId: "other", action: "click", x: 0.75, y: 0.5 },
      { op: "stop" },
      { op: "copy-selection", tabId: "active", requestId: "copy" },
      { op: "input", action: "copy", tabId: "active" },
      { op: "reload", showId: "show-secret-b" },
      { op: "input", action: "click", x: 2, y: 0 },
      { op: "navigate", url: "file:///etc/passwd" },
      { op: "navigate", url: "http://me:password@fixture.invalid/" },
      { op: "input", action: "text", text: "a".repeat(2049) },
    ]) {
      expect((await send(op)).status).toBe(400);
    }
    expect(f.control).not.toHaveBeenCalled();
    for (const op of [
      { op: "reload" },
      { op: "navigate", url: "https://fixture.invalid/path" },
      { op: "input", tabId: "visible", action: "click", x: 0.75, y: 0.5 },
    ]) {
      expect((await send(op)).ok).toBe(true);
      expect(f.control).toHaveBeenLastCalledWith("show-secret-a", op);
    }
    f.urls.delete("show-secret-a");
    expect((await send({ op: "reload" })).status).toBe(410);
  });
  it("withholds an in-flight frame after its show ends, and never forwards backend exception text", async () => {
    const f = fixture(),
      { url, cookie } = await f.claim();
    let done!: () => void, started!: () => void;
    const inFrame = new Promise<void>((r) => {
      started = r;
    });
    f.frame.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((r) => {
        done = r;
      });
      return png;
    });
    const response = fetch(new URL("frame", url), { headers: { cookie } });
    await inFrame;
    f.urls.delete("show-secret-a");
    done();
    expect((await response).status).toBe(410);
    const b = await f.claim("show-secret-b");
    f.frame.mockRejectedValueOnce(Error("/private/secret-path"));
    const failure = await fetch(new URL("frame", b.url), {
      headers: { cookie: b.cookie },
    });
    expect(failure.ok).toBe(false);
    expect(await failure.text()).not.toContain("secret-path");
    f.frame.mockResolvedValueOnce(Buffer.from("<script>unsafe</script>"));
    expect(
      (await fetch(new URL("frame", b.url), { headers: { cookie: b.cookie } }))
        .ok,
    ).toBe(false);
  });
});

it("does not issue a session when a pending ticket expires during the liveness check", async () => {
  let url = "",
    clock = 1,
    pause = false,
    ready!: () => void,
    finish!: () => void;
  const entered = new Promise<void>((r) => {
    ready = r;
  });
  const service = createDemoBrowser({
    openExternal: async (u) => {
      url = u;
    },
    status: async () => {
      if (pause) {
        ready();
        await new Promise<void>((r) => {
          finish = r;
        });
      }
      return { url: null };
    },
    frame: async () => png,
    nextFrame: async () => null,
    control: async () => {},
    now: () => clock,
  });
  cleanup.push(service.close);
  await service.open("fixture");
  pause = true;
  const redemption = fetch(url, { redirect: "manual" });
  await entered;
  clock += 65000;
  finish();
  const response = await redemption;
  expect(response.status).toBe(403);
  expect(response.headers.has("set-cookie")).toBe(false);
});
it("rejects oversized JSON without running controls and retires expired viewer sessions", async () => {
  const f = fixture(),
    a = await f.claim(),
    target = new URL("control", a.url);
  const post = (body: string) =>
    fetch(target, {
      method: "POST",
      headers: {
        origin: a.url.origin,
        cookie: a.cookie,
        "content-type": "application/json",
      },
      body,
    });
  expect(
    (
      await post(
        JSON.stringify({
          op: "input",
          action: "text",
          text: "X".repeat(60000),
        }),
      )
    ).status,
  ).toBe(413);
  expect(f.control).not.toHaveBeenCalled();
  expect((await post('{"op":"reload"}')).status).toBe(204);
  f.advance(5 * 60 * 60 * 1000);
  expect((await post('{"op":"reload"}')).status).toBe(403);
  expect(
    (await fetch(new URL("frame", a.url), { headers: { cookie: a.cookie } }))
      .status,
  ).toBe(403);
  expect(f.control).toHaveBeenCalledTimes(1);
});

it("publishes only the session-bound tab catalog, sanitizes addresses and rejects foreign tab controls", async () => {
  const f = fixture();
  const hostileTitle = '<img src=x onerror="window.injected=true">';
  f.catalogs.set("show-secret-a", {
    tabs: [
      { tabId: "tab-a", title: hostileTitle, url: "https://fixture.invalid/a" },
      { tabId: "tab-a-blank", title: "Новая вкладка", url: "about:blank" },
    ],
    activeTabId: "tab-a",
  });
  f.catalogs.set("show-secret-b", {
    tabs: [
      { tabId: "tab-b", title: "B only", url: "https://fixture.invalid/b" },
    ],
    activeTabId: "tab-b",
  });
  const a = await f.claim(),
    b = await f.claim("show-secret-b");
  const status = async (viewer: typeof a) =>
    (
      await fetch(new URL("status", viewer.url), {
        headers: { cookie: viewer.cookie },
      })
    ).json();
  expect(await status(a)).toEqual({
    url: "http://fixture.invalid/one",
    tabs: [
      { tabId: "tab-a", title: hostileTitle, url: "https://fixture.invalid/a" },
      { tabId: "tab-a-blank", title: "Новая вкладка", url: null },
    ],
    activeTabId: "tab-a",
  });
  expect(JSON.stringify(await status(a))).not.toContain("tab-b");
  expect((await status(b)).tabs.map((t: { tabId: string }) => t.tabId)).toEqual(
    ["tab-b"],
  );
  const send = (body: unknown) =>
    fetch(new URL("control", a.url), {
      method: "POST",
      headers: {
        origin: a.url.origin,
        cookie: a.cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  for (const body of [
    { op: "tab-create", showId: "show-secret-b" },
    { op: "tab-create", upstream: "http://evil.invalid" },
    { op: "tab-select", tabId: "tab-a", showId: "show-secret-b" },
    { op: "tab-close", tabId: "tab-a", upstream: "http://evil.invalid" },
    { op: "tab-select", tabId: "tab-b" },
    { op: "tab-close", tabId: "tab-b" },
    { op: "tab-select", tabId: "" },
    { op: "tab-close", tabId: "../../tab-a" },
    { op: "tab-select", tabId: "x".repeat(101) },
    { op: "tab-close" },
  ])
    expect((await send(body)).status).toBe(400);
  expect(f.control).not.toHaveBeenCalled();
  for (const body of [
    { op: "tab-create" },
    { op: "tab-select", tabId: "tab-a-blank" },
    { op: "tab-close", tabId: "tab-a" },
  ]) {
    expect((await send(body)).status).toBe(204);
    expect(f.control).toHaveBeenLastCalledWith("show-secret-a", body);
  }
  f.catalogs.set("show-secret-a", { tabs: [], activeTabId: null });
  expect(await status(a)).toMatchObject({ tabs: [], activeTabId: null });
  expect((await send({ op: "tab-create" })).status).toBe(204);
});

it("renders safe selectable and closable tabs above the address and follows agent selection", async () => {
  const f = fixture(),
    { url, cookie } = await f.claim();
  const html = await (await fetch(url, { headers: { cookie } })).text();
  const source = await (
    await fetch(new URL("viewer.js", url), { headers: { cookie } })
  ).text();
  document.body.innerHTML = new DOMParser().parseFromString(
    html,
    "text/html",
  ).body.innerHTML;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  const title = '<img src=x onerror="window.injected=true">';
  let state: {
    url: string | null;
    tabs?: { tabId: string; title: string; url: string | null }[];
    activeTabId?: string | null;
  } = {
    url: "https://fixture.invalid/a",
    tabs: [
      { tabId: "tab-a", title, url: "https://fixture.invalid/a" },
      { tabId: "tab-b", title: "Second", url: "https://fixture.invalid/b" },
    ],
    activeTabId: "tab-a",
  };
  const commands: unknown[] = [];
  let poll: (() => Promise<void>) | undefined;
  const fakeFetch = vi.fn(async (path: string, options?: { body?: string }) => {
    if (path === "control") commands.push(JSON.parse(options!.body!));
    return {
      ok: true,
      status: path === "next" ? 204 : 200,
      json: async () => state,
      blob: async () => new Blob([png]),
    };
  });
  new Function("document", "fetch", "URL", "setTimeout", source)(
    document,
    fakeFetch,
    {
      createObjectURL: () => "blob:fixture",
      revokeObjectURL: () => {},
    },
    (fn: () => Promise<void>, delay: number) => {
      if (delay === 450) poll = fn;
    },
  );
  await vi.waitFor(() =>
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2),
  );
  const list = document.querySelector('[role="tablist"]')!;
  const address = document.querySelector<HTMLInputElement>("#address")!;
  expect(
    list.compareDocumentPosition(address) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(list.textContent).toContain(title);
  expect(list.querySelector("img")).toBeNull();
  const first = document.querySelector<HTMLButtonElement>(
    '[role="tab"][aria-selected="true"]',
  )!;
  expect(first.textContent).toBe(title);
  document
    .querySelector<HTMLButtonElement>('[role="tab"][aria-selected="false"]')!
    .click();
  await vi.waitFor(() =>
    expect(commands).toContainEqual({ op: "tab-select", tabId: "tab-b" }),
  );
  document
    .querySelector<HTMLButtonElement>('[aria-label="Закрыть вкладку Second"]')!
    .click();
  document
    .querySelector<HTMLButtonElement>('[aria-label="Новая вкладка"]')!
    .click();
  await vi.waitFor(() => expect(commands).toContainEqual({ op: "tab-create" }));
  expect(commands).toContainEqual({ op: "tab-close", tabId: "tab-b" });
  state = { ...state, url: "https://fixture.invalid/b", activeTabId: "tab-b" };
  await vi.waitFor(() => expect(poll).toBeTypeOf("function"));
  await poll!();
  expect(
    document.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
  ).toBe("Second");
  expect(address.value).toBe("https://fixture.invalid/b");
  address.focus();
  address.value = "https://fixture.invalid/draft-for-b";
  address.dispatchEvent(new Event("input", { bubbles: true }));
  state = { ...state, url: "https://fixture.invalid/b#same-tab-navigation" };
  await poll!();
  expect(address.value).toBe("https://fixture.invalid/draft-for-b");
  state = { ...state, url: "https://fixture.invalid/a", activeTabId: "tab-a" };
  await poll!();
  expect(address.value).toBe("https://fixture.invalid/a");
  document
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(commands).toContainEqual({
      op: "navigate",
      url: "https://fixture.invalid/a",
    }),
  );
  expect(commands).not.toContainEqual({
    op: "navigate",
    url: "https://fixture.invalid/draft-for-b",
  });
  address.value = "https://fixture.invalid/draft-for-a";
  address.dispatchEvent(new Event("input", { bubbles: true }));
  state = { url: null, tabs: [], activeTabId: null };
  await poll!();
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(
    document.querySelector<HTMLButtonElement>('[aria-label="Новая вкладка"]')!
      .disabled,
  ).toBe(false);
  expect(address.value).toBe("");
  state = { url: "https://fixture.invalid/legacy" };
  await poll!();
  expect(address.value).toBe("https://fixture.invalid/legacy");
});

it("discards an old streamed image when the active tab changes during decode", async () => {
  const f = fixture(),
    { url, cookie } = await f.claim();
  const html = await (await fetch(url, { headers: { cookie } })).text();
  const source = await (
    await fetch(new URL("viewer.js", url), { headers: { cookie } })
  ).text();
  // Separate document: the synthetic viewer owns all its listeners.
  const doc = new DOMParser().parseFromString(html, "text/html");
  Object.defineProperty(doc, "hidden", { configurable: true, value: false });
  let tab = "one",
    poll!: () => Promise<void>,
    pull!: () => Promise<void>,
    finish!: () => void;
  const released: string[] = [],
    requested: string[] = [];
  const mockFetch = vi.fn(async (name: string, opts?: RequestInit) => {
    const bound = tab;
    if (name === "next")
      requested.push((opts?.headers as Record<string, string>)["x-demo-tab"]);
    return {
      status: 200,
      ok: true,
      json: async () => ({ activeTabId: bound, tabs: [], url: null }),
      headers: { get: () => "cursor-" + bound },
      blob: async () => new Blob([bound]),
    };
  });
  let seq = 0;
  new Function("document", "fetch", "URL", "Image", "setTimeout", source)(
    doc,
    mockFetch,
    {
      createObjectURL: () => "blob:" + ++seq,
      revokeObjectURL: (s: string) => released.push(s),
    },
    class {
      decode() {
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
    },
    (fn: () => Promise<void>, delay: number) => {
      if (delay === 450) poll = fn;
      else pull = fn;
    },
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  tab = "two";
  await poll();
  finish();
  await vi.waitFor(() => expect(released).toContain("blob:1"));
  const image = doc.querySelector("#frame")!;
  expect(image.getAttribute("src")).toBeNull();
  const pending = pull();
  await vi.waitFor(() => expect(seq).toBe(2));
  finish();
  await pending;
  expect(requested).toEqual(["one", "two"]);
  expect(image.getAttribute("src")).toBe("blob:2");
});
