import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { createServer } from "node:net";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { Demonstrations } from "../src/host/demonstrations/runtime";
import { createPageDisplay } from "../src/host/demonstrations/display";
import { launchBrowser } from "../src/host/demonstrations/browser";
import {
  createAgentBroker,
  createPipeTarget,
  type PipeTarget,
} from "../src/host/demonstrations/transport.cjs";
import { createLiveView } from "../src/host/demonstrations/live-view.cjs";
import type { ScopeRef } from "../src/shared/context";

// The executable speaks only the browser pipe protocol used by this fixture.
// No installed browser, user profile, network pages or real project is involved.
const executable = `#!${process.execPath}
const fs=require('node:fs');let session=0,watcher=null,targetSerial=0;
fs.appendFileSync(__filename+'.launch',JSON.stringify({cwd:process.cwd(),home:process.env.HOME,args:process.argv.slice(2),secrets:process.env.GOGA_DEMO_TEST_SENTINEL??null})+'\\n');
const frame={id:'main',url:process.argv.at(-1)},downloads=[];
const pages=new Map([['shown',frame]]),sessions=new Map(),watchers=new Map(),gestures=[];
const send=m=>fs.writeSync(4,JSON.stringify(m)+'\\0');
const input=fs.createReadStream(null,{fd:3});let buffered='';
input.on('data',data=>{buffered+=data;let end;while((end=buffered.indexOf('\\0'))>=0){
 const {id,method,params={},sessionId}=JSON.parse(buffered.slice(0,end));buffered=buffered.slice(end+1);let result={};
 if(method==='Fixture.inspect')result={pid:process.pid,downloads,gestures};
 if(method==='Target.createBrowserContext')result={browserContextId:'extra-context'};
 if(method==='Browser.setDownloadBehavior'||method==='Page.setDownloadBehavior')downloads.push({method,params});
 if(method==='Fixture.breakPipe'){fs.closeSync(4);continue;}
 if(method==='Fixture.closePage'){
   // Observed in real Chrome: close of a tab notifies each attached session;
   // a browser-level detach identifies the session that was actually lost.
   const sid=params.shown?watcher:'unrelated-host-session';
   if(params.shown)pages.delete('shown');
   send({id,result,sessionId});
   send({method:'Inspector.detached',sessionId:sid,params:{reason:'Render process gone.'}});
   send({method:'Target.detachedFromTarget',params:{sessionId:sid,targetId:params.shown?'shown':'other'}});
   continue;
 }
 if(method==='Target.createTarget'){const targetId='new-'+(++targetSerial);pages.set(targetId,{id:targetId,url:params.url});result={targetId};}
 if(method==='Target.getTargets')result={targetInfos:[...pages].map(([targetId,f])=>({targetId,type:'page',url:f.url,title:f.title||''}))};
 if(method==='Target.activateTarget'&&!pages.has(params.targetId)){send({id,error:{code:-32000,message:'No such target'},sessionId});continue;}
 if(method==='Target.closeTarget'){
   pages.delete(params.targetId);send({id,result:{success:true},sessionId});
   const sid=watchers.get(params.targetId);if(sid)send({method:'Target.detachedFromTarget',params:{sessionId:sid,targetId:params.targetId}});
   continue;
 }
 if(method==='Target.attachToTarget'||method==='Target.attachToBrowserTarget'){result={sessionId:'s-'+(++session)};sessions.set(result.sessionId,params.targetId);}
 const targetId=sessions.get(sessionId),selected=pages.get(targetId)||frame;
 if(method==='Page.enable'){watcher=sessionId;watchers.set(targetId,sessionId);}
 if(method==='Page.getFrameTree')result={frameTree:{frame:selected}};
 if(method==='Page.getLayoutMetrics')result={cssVisualViewport:{clientWidth:100,clientHeight:50,pageX:0,pageY:0}};
 if(method==='Page.startScreencast'){
   send({method:'Page.screencastFrame',sessionId,params:{sessionId:1,data:Buffer.from('pixels:'+targetId).toString('base64')}});
   send({method:'Page.screencastFrame',sessionId:'agent-or-foreign',params:{sessionId:2,data:Buffer.from('foreign').toString('base64')}});
 }
 if(method==='Page.captureScreenshot')result={data:Buffer.from(targetId==='shown'?'png fixture':'png:'+selected.url).toString('base64')};
 if(method==='Page.reload'||method.startsWith('Input.'))gestures.push({method,targetId,params});
 if(method==='Page.navigate'){selected.url=params.url;send({method:'Page.frameNavigated',params:{frame:selected},sessionId:watchers.get(targetId)});}
 send({id,result,sessionId});
}});
input.on('end',()=>process.exit(0));
`;
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const topic = (revision: string): ScopeRef => ({
  projectId: "one",
  topic: "demo",
  year: "2026",
  branch: "topic",
  contextId: "ctx-" + "1".repeat(64),
  revision,
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function setup(failEmbedded = false) {
  const dir = await mkdtemp(join(tmpdir(), "goga-demo-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const chromePath = join(dir, "fake-chromium");
  await writeFile(chromePath, executable, { mode: 0o700 });
  const settingsFile = join(dir, "settings.json");
  const embedded = vi.fn(
    (
      ...args: Parameters<typeof launchBrowser> extends [unknown, ...infer A]
        ? A
        : never
    ) => {
      if (failEmbedded) throw new Error("Тестовый отказ");
      return launchBrowser(chromePath, ...args);
    },
  );
  const runtime = new Demonstrations({
    settingsFile,
    chromePath,
    launchEmbedded: embedded,
  });
  cleanups.push(() => runtime.close());
  return {
    runtime,
    port: await freePort(),
    settingsFile,
    chromePath,
    embedded,
  };
}
async function ask(
  ws: WebSocket,
  method: string,
  params = {},
  sessionId?: string,
) {
  const message = once(ws, "message", { signal: AbortSignal.timeout(3000) });
  ws.send(JSON.stringify({ id: 1, method, params, sessionId }));
  const [event] = await message;
  return JSON.parse(event.data);
}
describe("isolated demonstrations", () => {
  it("streams frames only for the requested show's active opaque tab, rejecting a waiting read when it is replaced", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "first" });
    await runtime.execute({ action: "open", scope: "second" });
    const [first, second] = runtime.shows();
    const id = first.activeTabId!;
    await expect(
      runtime.nextFrame(first.showId, second.activeTabId!, null),
    ).rejects.toThrow();
    const frame = await runtime.nextFrame(first.showId, id, null);
    expect(Buffer.from(frame!.pixels).toString()).toBe("pixels:shown");
    const pending = expect(
      runtime.nextFrame(first.showId, id, frame!.cursor),
    ).rejects.toThrow();
    await runtime.execute({ action: "tab-create", showId: first.showId });
    await pending;
    await expect(runtime.nextFrame(first.showId, id, null)).rejects.toThrow();
    const other = await runtime.nextFrame(
      second.showId,
      second.activeTabId!,
      frame!.cursor,
    );
    expect(Buffer.from(other!.pixels).toString()).toBe("pixels:shown");
    expect(other!.cursor).not.toBe(frame!.cursor);
  });

  it("rejects delayed and foreign user gestures instead of sending them to the newly selected tab", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "input-owner" });
    await runtime.execute({ action: "open", scope: "neighbor" });
    const [a, b] = runtime.shows(),
      old = a.activeTabId!,
      foreign = b.activeTabId!;
    await runtime.execute({ action: "tab-create", showId: a.showId });
    const selected = runtime.shows()[0].activeTabId!;
    const gesture = (tabId: string) =>
      runtime.execute({
        action: "input",
        showId: a.showId,
        tabId,
        input: { action: "text", text: tabId },
      });
    await expect(gesture(old)).rejects.toThrow();
    await expect(gesture(foreign)).rejects.toThrow();
    await gesture(selected);
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
    cleanups.push(async () => {
      ws.close();
    });
    await once(ws, "open");
    const { gestures } = (await ask(ws, "Fixture.inspect")).result;
    expect(
      gestures
        .filter((e: { method: string }) => e.method === "Input.insertText")
        .map((e: { params: { text: string } }) => e.params.text),
    ).toEqual([selected]);
  });

  it("keeps browser tab aliases private and reuses its one process/profile when closing the last UI tab", async () => {
    const { chromePath } = await setup();
    const signal = new AbortController().signal,
      lost = vi.fn();
    const a = await launchBrowser(chromePath, lost, signal, (close) =>
        cleanups.push(close),
      ),
      b = await launchBrowser(chromePath, lost, signal, (close) =>
        cleanups.push(close),
      );
    const initial = a.tabSnapshot().tabs[0],
      foreign = b.tabSnapshot().tabs[0];
    expect(initial.tabId).not.toBe(foreign.tabId);
    await expect(a.selectTab(foreign.tabId)).rejects.toThrow();
    await expect(a.closeTab(foreign.tabId)).rejects.toThrow();
    const before = await a.pipe.command("Fixture.inspect");
    await a.createTab();
    expect(a.tabSnapshot().tabs).toHaveLength(2);
    const created = a.tabSnapshot().activeTabId!;
    await a.closeTab(initial.tabId);
    await a.closeTab(created);
    await a.refreshTabs();
    expect(a.tabSnapshot().tabs).toHaveLength(1);
    expect(a.navigation.url).toBeNull();
    expect(await a.pipe.command("Fixture.inspect")).toEqual(before);
    expect(a.alive()).toBe(true);
    expect(lost).not.toHaveBeenCalled();
    expect(
      (await readFile(chromePath + ".launch", "utf8")).trim().split("\n"),
    ).toHaveLength(2);
    expect(Buffer.from(await b.view.frame()).toString()).toBe("png fixture");
  });

  it("displays the page explicitly activated by a CDP agent, including frames, address, input and reload", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "display" });
    await runtime.execute({ action: "open", scope: "neighbor" });
    const [a, b] = runtime.shows();
    const c = new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
    cleanups.push(async () => {
      c.close();
    });
    await once(c, "open");
    const url = "http://127.0.0.1:8917/landing";
    const { targetId } = (await ask(c, "Target.createTarget", { url })).result;
    // Merely creating a sibling does not choose what the user sees.
    expect(runtime.shows()[0].url).toBeNull();
    expect(
      (await ask(c, "Target.activateTarget", { targetId })).error,
    ).toBeUndefined();
    expect(runtime.shows().map((s) => s.url)).toEqual([url, null]);
    expect(Buffer.from(await runtime.frame(a.showId)).toString()).toBe(
      "png:" + url,
    );
    expect(Buffer.from(await runtime.frame(b.showId)).toString()).toBe(
      "png fixture",
    );
    await runtime.execute({ action: "reload", showId: a.showId });
    await runtime.execute({
      action: "input",
      showId: a.showId,
      input: { action: "text", text: "hello" },
    });
    const { gestures } = (await ask(c, "Fixture.inspect")).result;
    expect(gestures.map((g: { targetId: string }) => g.targetId)).toEqual([
      targetId,
      targetId,
    ]);
    // Retiring the old placeholder is no longer a loss of the displayed page.
    await ask(c, "Target.closeTarget", { targetId: "shown" });
    expect(runtime.shows()).toHaveLength(2);
    const disconnected = once(c, "close");
    c.close();
    await disconnected;
    await vi.waitFor(async () =>
      expect((await runtime.state()).access.phase).toBe("waiting"),
    );
    expect(runtime.shows()[0].url).toBe(url);
    expect(Buffer.from(await runtime.frame(a.showId)).toString()).toBe(
      "png:" + url,
    );
  });
  it("replaces a physically lost last page without releasing its show, private profile or agent port", async () => {
    const { runtime, port, chromePath } = await setup();
    await runtime.execute({ action: "port", port });
    for (const scope of ["display", "neighbor"])
      await runtime.execute({ action: "open", scope });
    const [a, b] = runtime.shows(),
      profiles = (await readFile(chromePath + ".launch", "utf8"))
        .trim()
        .split("\n")
        .map((row) => JSON.parse(row).home);
    const c = new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
    cleanups.push(async () => {
      c.close();
    });
    await once(c, "open");
    await ask(c, "Fixture.closePage", { shown: false });
    expect((await runtime.state()).access).toMatchObject({
      owner: a.showId,
      phase: "connected",
    });
    await ask(c, "Fixture.closePage", { shown: true });
    await vi.waitFor(async () =>
      expect(Buffer.from(await runtime.frame(a.showId)).toString()).toBe(
        "png:about:blank",
      ),
    );
    expect(runtime.shows().map((s) => s.showId)).toEqual([a.showId, b.showId]);
    expect((await runtime.state()).access).toMatchObject({
      owner: a.showId,
      phase: "connected",
    });
    expect((await ask(c, "Fixture.inspect")).result.pid).toBeTruthy();
    expect(await realpath(profiles[0])).toBeTruthy();
    expect(await realpath(profiles[1])).toBeTruthy();
    expect(Buffer.from(await runtime.frame(b.showId)).toString()).toBe(
      "png fixture",
    );
    const disconnected = once(c, "close");
    await runtime.execute({ action: "stop", showId: a.showId });
    await disconnected;
    expect((await runtime.state()).access.owner).toBeNull();
    await expect(runtime.frame(a.showId)).rejects.toThrow();
    await expect(
      fetch("http://127.0.0.1:" + port + "/json/version"),
    ).rejects.toThrow();
    await expect(realpath(profiles[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await realpath(profiles[1])).toBeTruthy();
    expect(runtime.hasProject("neighbor")).toBe(true);
  });
  it("keeps selection on activation failure and selects a surviving neighbor when the active page closes", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    for (const scope of ["display", "neighbor"])
      await runtime.execute({ action: "open", scope });
    const [a, b] = runtime.shows();
    const c = new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
    cleanups.push(async () => {
      c.close();
    });
    await once(c, "open");
    const { targetId } = (
      await ask(c, "Target.createTarget", {
        url: "http://fixture.invalid/selected",
      })
    ).result;
    await ask(c, "Target.activateTarget", { targetId });
    expect(
      (
        await ask(c, "Target.activateTarget", {
          targetId: "not-in-this-browser",
        })
      ).error,
    ).toBeTruthy();
    expect(runtime.shows()[0].url).toBe("http://fixture.invalid/selected");
    await runtime.execute({
      action: "navigate",
      showId: a.showId,
      url: "http://fixture.invalid/redirect",
    });
    expect(runtime.shows()[0].url).toBe("http://fixture.invalid/redirect");
    await ask(c, "Target.closeTarget", { targetId });
    await vi.waitFor(async () =>
      expect(Buffer.from(await runtime.frame(a.showId)).toString()).toBe(
        "png fixture",
      ),
    );
    expect(runtime.shows().map((s) => s.showId)).toEqual([a.showId, b.showId]);
    expect((await runtime.state()).access).toMatchObject({
      owner: a.showId,
      phase: "connected",
    });
    expect(runtime.shows()[0].url).toBeNull();
    expect(Buffer.from(await runtime.frame(b.showId)).toString()).toBe(
      "png fixture",
    );
  });
  it("follows Playwright-style Page.bringToFront only in an agent-owned page session", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "display" });
    const c = new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
    cleanups.push(async () => {
      c.close();
    });
    await once(c, "open");
    const url = "https://fixture.invalid/playwright";
    const { targetId } = (await ask(c, "Target.createTarget", { url })).result;
    const { sessionId } = (
      await ask(c, "Target.attachToTarget", { targetId, flatten: true })
    ).result;
    expect(
      (await ask(c, "Page.bringToFront", {}, sessionId)).error,
    ).toBeUndefined();
    expect(runtime.shows()[0].url).toBe(url);
    expect((await ask(c, "Page.bringToFront", {}, "s-1")).error).toBeTruthy();
    expect(runtime.shows()[0].url).toBe(url);
  });
  it("uses one private process per owner, never resolves client-provided upstreams or guessed host sessions", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    for (const scope of ["first", "second"])
      await runtime.execute({ action: "open", scope });
    const [a, b] = runtime.shows();
    const url = "ws://127.0.0.1:" + port + "/devtools/browser";
    const connect = async () => {
      const c = new WebSocket(url);
      await once(c, "open");
      return c;
    };
    const first = await connect();
    const pid = (await ask(first, "Fixture.inspect")).result.pid;
    for (const method of [
      "Browser.setDownloadBehavior",
      "Page.setDownloadBehavior",
    ]) {
      expect(
        (
          await ask(first, method, {
            behavior: "allowAndName",
            downloadPath: "/outside/profile",
            eventsEnabled: true,
          })
        ).result,
      ).toBeTruthy();
    }
    expect(
      (await ask(first, "Target.createBrowserContext")).result.browserContextId,
    ).toBe("extra-context");
    const settings = (await ask(first, "Fixture.inspect")).result.downloads;
    expect(settings).toContainEqual({
      method: "Browser.setDownloadBehavior",
      params: { behavior: "deny", browserContextId: "extra-context" },
    });
    expect(settings.length).toBeGreaterThan(0);
    expect(
      settings.every(
        (x: { params: Record<string, unknown> }) =>
          x.params.behavior === "deny" &&
          !Object.hasOwn(x.params, "downloadPath"),
      ),
    ).toBe(true);
    // The fake Chromium chooses s-1 for the *private* host navigation session.
    expect((await ask(first, "Fixture.inspect", {}, "s-1")).error).toBeTruthy();
    expect(
      (await ask(first, "Target.detachFromTarget", { sessionId: "s-1" })).error,
    ).toBeTruthy();
    for (const method of [
      "Target.attachToBrowserTarget",
      "Target.sendMessageToTarget",
      "Target.exposeDevToolsProtocol",
      "Target.setRemoteLocations",
      "Tethering.bind",
      "Browser.close",
    ]) {
      expect((await ask(first, method)).error).toBeTruthy();
    }
    const closed = once(first, "close");
    await runtime.execute({
      action: "switch-port",
      showId: b.showId,
      fromShowId: a.showId,
    });
    await closed;
    const next = await connect();
    expect((await ask(next, "Fixture.inspect")).result.pid).not.toBe(pid);
    const dead = once(next, "close");
    next.send(JSON.stringify({ id: 77, method: "Fixture.breakPipe" }));
    await dead;
    await vi.waitFor(
      () => expect(runtime.shows().map((s) => s.showId)).toEqual([a.showId]),
      { timeout: 2500 },
    );
    expect((await runtime.state()).access.phase).toBe("off");
    await expect(
      fetch("http://127.0.0.1:" + port + "/json/version"),
    ).rejects.toThrow();
  });
  it("keeps a failed shutdown owned but inaccessible, and retries until its browser actually exits", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "owner" });
    const id = runtime.shows()[0].showId;
    const children = new Set<ChildProcess>();
    const fakeKill = vi
      .spyOn(ChildProcess.prototype, "kill")
      .mockImplementation(function (this: ChildProcess) {
        children.add(this);
        throw Object.assign(Error("temporary failure"), { code: "EPERM" });
      });
    try {
      await expect(
        runtime.execute({ action: "stop", showId: id }),
      ).rejects.toThrow();
      expect(runtime.hasProject("owner")).toBe(true);
      expect(runtime.shows().map((s) => s.showId)).toEqual([id]);
      expect((await runtime.state()).access.owner).toBeNull();
      await expect(runtime.frame(id)).rejects.toThrow();
      await expect(
        runtime.execute({ action: "open", scope: "owner" }),
      ).rejects.toThrow();
      await expect(
        runtime.execute({
          action: "switch-port",
          showId: id,
          fromShowId: null,
        }),
      ).rejects.toThrow();
      await expect(runtime.close()).rejects.toThrow();
      expect(runtime.shows()).toHaveLength(1);
      fakeKill.mockRestore();
      await runtime.close();
      expect(runtime.shows()).toEqual([]);
      expect(runtime.hasProject("owner")).toBe(false);
    } finally {
      fakeKill.mockRestore();
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
    }
  }, 12000);
  it("migrates a legacy port lazily, pins live shows to their engine and changes only future shows", async () => {
    const { runtime, port, settingsFile, embedded } = await setup();
    await writeFile(settingsFile, JSON.stringify({ port }));
    expect(await runtime.state()).toMatchObject({ port, engine: "embedded" });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ port });
    await runtime.execute({ action: "open", scope: "first" });
    const initial = await runtime.state();
    expect(initial.shows[0].engine).toBe("embedded");
    await runtime.execute({ action: "engine", engine: "system" });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
      port,
      engine: "system",
    });
    await runtime.execute({ action: "open", scope: "first" });
    await runtime.execute({ action: "open", scope: "second" });
    expect(embedded).toHaveBeenCalledTimes(1);
    const changed = await runtime.state();
    expect(changed.access).toEqual(initial.access);
    expect(changed.shows.map((s) => s.engine)).toEqual(["embedded", "system"]);
    expect(changed.shows[0].showId).toBe(initial.shows[0].showId);
    await runtime.execute({ action: "stop", showId: changed.shows[0].showId });
    const nextPort = await freePort();
    await runtime.execute({ action: "port", port: nextPort });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
      port: nextPort,
      engine: "system",
    });
    expect((await new Demonstrations({ settingsFile }).state()).engine).toBe(
      "system",
    );
  });
  it("never implicitly launches the system browser; an explicit retry does not change the default", async () => {
    const { runtime, port, settingsFile, chromePath, embedded } =
      await setup(true);
    await runtime.execute({ action: "port", port });
    await expect(
      runtime.execute({ action: "open", scope: "one" }),
    ).rejects.toThrow(/встроенный Chromium.*Тестовый отказ/);
    expect((await runtime.state()).shows).toEqual([]);
    await expect(readFile(chromePath + ".launch")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await runtime.execute({ action: "open", scope: "one", engine: "system" });
    expect(runtime.shows()[0].engine).toBe("system");
    expect(JSON.parse(await readFile(settingsFile, "utf8")).engine).toBe(
      "embedded",
    );
    await expect(
      runtime.execute({ action: "open", scope: "two" }),
    ).rejects.toThrow(/встроенный Chromium/);
    expect(embedded).toHaveBeenCalledTimes(2);
  });
  it("does not replace a valid saved port when repairing an unknown engine", async () => {
    const { runtime, port, settingsFile, embedded } = await setup();
    await writeFile(settingsFile, JSON.stringify({ port, engine: "other" }));
    expect(await runtime.state()).toMatchObject({
      port,
      settingsError: expect.any(String),
    });
    await expect(
      runtime.execute({ action: "open", scope: "one", engine: "system" }),
    ).rejects.toThrow(/настройки/);
    expect(embedded).not.toHaveBeenCalled();
    await runtime.execute({ action: "port", port });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
      port,
      engine: "embedded",
    });
  });
  it("allows explicit settings repair but never silently binds a fallback port for corrupt preferences", async () => {
    const { runtime, port, settingsFile } = await setup();
    await writeFile(settingsFile, "{corrupt!");
    expect(runtime.shows()).toEqual([]);
    const bad = await runtime.state();
    expect(bad.settingsError).toBeTruthy();
    expect(bad.access.owner).toBeNull();
    const broken = new Demonstrations({
      settingsFile: join(settingsFile, "private-name.json"),
    });
    try {
      await expect(broken.execute({ action: "port", port })).rejects.toThrow(
        "Не удалось сохранить порт демонстрации.",
      );
    } finally {
      await broken.close();
    }
    await expect(
      runtime.execute({ action: "open", scope: "one" }),
    ).rejects.toThrow(/порт/);
    expect(runtime.hasProject("one")).toBe(false);
    await runtime.execute({ action: "port", port });
    expect((await runtime.state()).settingsError).toBeUndefined();
    await runtime.execute({ action: "open", scope: "one" });
    expect((await runtime.state()).port).toBe(port);
  });
  it("inventories a pending owner synchronously, starts a private profile without inherited secrets and removes it on close", async () => {
    const { runtime, chromePath, port } = await setup();
    await runtime.execute({ action: "port", port });
    expect(runtime.shows()).toEqual([]);
    const previous = process.env.GOGA_DEMO_TEST_SENTINEL;
    process.env.GOGA_DEMO_TEST_SENTINEL = "test fixture";
    try {
      const opening = runtime.execute({ action: "open", scope: "alpha" });
      expect(runtime.hasProject("alpha")).toBe(true);
      await opening;
      const [s] = runtime.shows();
      const launch = JSON.parse(await readFile(chromePath + ".launch", "utf8"));
      expect(launch.secrets).toBeNull();
      expect(await realpath(launch.home)).toEqual(await realpath(launch.cwd));
      expect(launch.home).not.toEqual(process.env.HOME);
      expect(launch.args).toContain("--remote-debugging-pipe");
      expect(launch.args).not.toContain("--no-sandbox");
      expect(
        launch.args.some((a: string) =>
          a.startsWith("--remote-debugging-port"),
        ),
      ).toBe(false);
      await runtime.execute({ action: "stop", showId: s.showId });
      expect(runtime.hasProject("alpha")).toBe(false);
      await expect(
        readFile(join(launch.home, "profile/Preferences")),
      ).rejects.toThrow();
      const fs = await import("node:fs/promises");
      await expect(fs.stat(launch.home)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previous === undefined) delete process.env.GOGA_DEMO_TEST_SENTINEL;
      else process.env.GOGA_DEMO_TEST_SENTINEL = previous;
    }
  });
  it("one CDP client; reconnects after release, rejects web origins and stale handoffs; frames expose only their PNG bytes", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    await runtime.execute({ action: "open", scope: "project" });
    const showId = runtime.shows()[0].showId,
      url = "http://127.0.0.1:" + port + "/json/version/";
    expect(
      (await fetch(url, { headers: { Origin: "https://untrusted.invalid" } }))
        .status,
    ).toBe(403);
    const { webSocketDebuggerUrl } = (await (await fetch(url)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const a = new WebSocket(webSocketDebuggerUrl);
    await once(a, "open");
    const first = (await runtime.state()).access.connectionId!;
    expect(first).toBeTruthy();
    const bad = new WebSocket(webSocketDebuggerUrl);
    await once(bad, "error");
    const done = once(a, "close");
    a.close();
    await done;
    const b = new WebSocket(webSocketDebuggerUrl);
    await once(b, "open");
    const current = (await runtime.state()).access.connectionId!;
    expect(current).not.toBe(first);
    await expect(
      runtime.execute({ action: "handoff", showId, connectionId: first }),
    ).rejects.toThrow();
    expect((await runtime.state()).access.connectionId).toBe(current);
    const retired = once(b, "close");
    await runtime.execute({ action: "handoff", showId, connectionId: current });
    await retired;
    expect((await runtime.state()).access.phase).toBe("waiting");
    const frame = await runtime.frame(showId);
    expect(frame.buffer.byteLength).toBe(frame.byteLength);
  });
  it("starts offline, persists an exact port and rejects a busy port without leaking a show", async () => {
    const { runtime, port, settingsFile } = await setup();
    expect(await runtime.state()).toMatchObject({
      port: 45123,
      shows: [],
      access: { phase: "off", owner: null },
    });
    await runtime.execute({ action: "port", port });
    expect(JSON.parse(await readFile(settingsFile, "utf8")).port).toBe(port);
    const s = createServer();
    s.listen(port, "127.0.0.1");
    await once(s, "listening");
    try {
      await expect(
        runtime.execute({ action: "open", scope: "one" }),
      ).rejects.toThrow(/занят/);
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
    expect((await runtime.state()).shows).toEqual([]);
    await runtime.execute({ action: "open", scope: "one" }, "Проект");
    const state = await runtime.state();
    expect(state.shows).toHaveLength(1);
    expect(state.shows[0]).toMatchObject({
      scope: "one",
      label: "Проект",
      url: null,
    });
    expect(state.access).toMatchObject({
      owner: state.shows[0].showId,
      phase: "waiting",
    });
    await expect(
      runtime.execute({ action: "port", port: await freePort() }),
    ).rejects.toThrow();
    await runtime.close();
    await expect(
      fetch("http://127.0.0.1:" + port + "/json/version/"),
    ).rejects.toThrow();
    await expect(
      runtime.execute({ action: "open", scope: "one" }),
    ).rejects.toThrow();
  });
  it("isolates scope revisions, frames, navigation and ownership; stale commands cannot apply after close", async () => {
    const { runtime, port } = await setup();
    await runtime.execute({ action: "port", port });
    const one = topic("a3bfd7f4-a218-42b0-a4ac-ab8db45802cf"),
      two = topic("c2178a36-6451-4653-ae69-6371253e7907");
    await Promise.all(
      [one, one, two].map((scope) =>
        runtime.execute({ action: "open", scope }),
      ),
    );
    const [first, second] = (await runtime.state()).shows;
    expect((await runtime.state()).shows).toHaveLength(2);
    expect(first.showId).not.toEqual(second.showId);
    expect(Buffer.from(await runtime.frame(first.showId)).toString()).toEqual(
      "png fixture",
    );
    await runtime.execute({
      action: "navigate",
      showId: second.showId,
      url: "https://example.invalid/page#section",
    });
    expect((await runtime.state()).shows.map((s) => s.url)).toEqual([
      null,
      "https://example.invalid/page#section",
    ]);
    await expect(
      runtime.execute({
        action: "navigate",
        showId: first.showId,
        url: "file:///etc/passwd",
      }),
    ).rejects.toThrow();
    await expect(
      runtime.execute({
        action: "switch-port",
        showId: second.showId,
        fromShowId: null,
      }),
    ).rejects.toThrow();
    await runtime.execute({
      action: "switch-port",
      showId: second.showId,
      fromShowId: first.showId,
    });
    await runtime.execute({ action: "stop", showId: first.showId });
    expect((await runtime.state()).access.owner).toBe(second.showId);
    await expect(runtime.frame(first.showId)).rejects.toThrow();
    await expect(
      runtime.execute({ action: "stop", showId: first.showId }),
    ).rejects.toThrow();
    await runtime.execute({ action: "stop", showId: second.showId });
    expect((await runtime.state()).access.phase).toBe("off");
  }, 15000);
});

describe("atomic display selection", () => {
  function fixture() {
    let activate!: (id: string) => Promise<void>;
    const sessions: Array<{
      id: string;
      navigation?: (method: string) => void;
      closed: boolean;
      closeGate?: Promise<void>;
      commands: string[];
    }> = [];
    const lost = vi.fn();
    let capture: (() => Promise<{ data: string }>) | undefined;
    const targets = new Map(
      ["a", "b", "c"].map((targetId) => [
        targetId,
        {
          targetId,
          type: "page",
          title: targetId,
          url: "https://fixture.invalid/" + targetId,
        },
      ]),
    );
    const commands: Array<{ method: string; params: Record<string, unknown> }> =
      [];
    let serial = 0;
    let intercept:
      ((method: string, params: Record<string, unknown>) => void) | undefined;
    const pipe = {
      command: async (method: string, params: Record<string, unknown> = {}) => {
        commands.push({ method, params });
        intercept?.(method, params);
        if (method === "Target.getTargets")
          return { targetInfos: [...targets.values()] };
        if (method === "Target.createTarget") {
          const targetId = "new-" + ++serial;
          targets.set(targetId, {
            targetId,
            type: "page",
            title: "",
            url: String(params.url),
          });
          return { targetId };
        }
        if (!targets.has(String(params.targetId))) throw Error("No target");
        if (method === "Target.closeTarget") {
          targets.delete(String(params.targetId));
          for (const s of sessions)
            if (s.id === params.targetId && !s.closed) s.navigation?.("lost");
          return { success: true };
        }
        return {};
      },
      onPageActivated: (callback: typeof activate) => {
        activate = callback;
        return vi.fn();
      },
      attachHostPage: async (id: string) => {
        const s = {
          id,
          closed: false,
          commands: [],
        } as (typeof sessions)[number];
        sessions.push(s);
        return {
          onNavigation: (callback: (method: string) => void) => {
            s.navigation = callback;
          },
          command: async (method: string) => {
            s.commands.push(method);
            if (method === "Page.getFrameTree")
              return {
                frameTree: {
                  frame: { id, url: targets.get(id)?.url ?? "about:blank" },
                },
              };
            if (method === "Page.getLayoutMetrics")
              return {
                cssVisualViewport: {
                  clientWidth: 10,
                  clientHeight: 10,
                  pageX: 0,
                  pageY: 0,
                },
              };
            if (method === "Page.captureScreenshot")
              return capture
                ? capture()
                : { data: Buffer.from(id).toString("base64") };
            return {};
          },
          close: async () => {
            await s.closeGate;
            s.closed = true;
          },
        };
      },
    } as unknown as PipeTarget;
    return {
      pipe,
      sessions,
      targets,
      commands,
      intercept: (callback: typeof intercept) => {
        intercept = callback;
      },
      lost,
      activate: (id: string) => activate(id),
      capture: (f: typeof capture) => {
        capture = f;
      },
    };
  }
  it("inventories opaque ordered tab aliases, sanitizes metadata and revalidates membership for each command", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost),
      other = fixture(),
      neighbor = await createPageDisplay(other.pipe, "a", other.lost);
    cleanups.push(
      () => d.close(),
      () => neighbor.close(),
    );
    const initial = d.tabSnapshot();
    expect(initial.tabs.map((t) => t.title)).toEqual(["a", "b", "c"]);
    expect(initial.activeTabId).toBe(initial.tabs[0].tabId);
    expect(initial.tabs.every((t) => !["a", "b", "c"].includes(t.tabId))).toBe(
      true,
    );
    expect(neighbor.tabSnapshot().tabs[0].tabId).not.toBe(
      initial.tabs[0].tabId,
    );
    await expect(neighbor.selectTab(initial.tabs[0].tabId)).rejects.toThrow();
    await expect(neighbor.closeTab(initial.tabs[0].tabId)).rejects.toThrow();
    const b = f.targets.get("b")!;
    b.title = "\u0000Secret https://user:pass@fixture.invalid/b\n";
    b.url = "https://user:pass@fixture.invalid/b\n";
    await d.refreshTabs();
    expect(d.tabSnapshot().tabs[1]).toEqual({
      tabId: initial.tabs[1].tabId,
      title: "Secret https://fixture.invalid/b",
      url: "https://fixture.invalid/b",
    });
    const copy = d.tabSnapshot();
    copy.tabs.splice(0);
    expect(d.tabSnapshot().tabs).toHaveLength(3);
    f.targets.delete("b");
    await expect(d.selectTab(initial.tabs[1].tabId)).rejects.toThrow();
    await expect(d.closeTab(initial.tabs[1].tabId)).rejects.toThrow();
    expect(f.commands.some((x) => x.params.targetId === "b")).toBe(false);
  });
  it("creates and selects tabs, closes inactive tabs without switching, and chooses the right or left neighbor on active close", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    const original = d.tabSnapshot().tabs;
    await d.selectTab(original[1].tabId);
    expect(d.navigation.url).toBe("https://fixture.invalid/b");
    await d.closeTab(original[0].tabId);
    expect(d.tabSnapshot().activeTabId).toBe(original[1].tabId);
    await d.closeTab(original[1].tabId);
    expect(d.tabSnapshot().activeTabId).toBe(original[2].tabId);
    await d.createTab();
    const added = d.tabSnapshot().tabs.at(-1)!;
    expect(d.tabSnapshot().activeTabId).toBe(added.tabId);
    expect(added.url).toBeNull();
    await d.closeTab(added.tabId);
    expect(d.tabSnapshot().activeTabId).toBe(original[2].tabId);
    await d.closeTab(original[2].tabId);
    const blank = d.tabSnapshot();
    expect(blank.tabs).toHaveLength(1);
    expect(blank.activeTabId).toBe(blank.tabs[0].tabId);
    expect(blank.tabs[0].url).toBeNull();
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("preserves order across browser reordering, includes agent-created tabs and synchronizes explicit agent selection", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    const original = d.tabSnapshot();
    const a = f.targets.get("a")!;
    f.targets.delete("a");
    f.targets.set("a", a);
    f.targets.set("agent", {
      targetId: "agent",
      type: "page",
      title: "Agent page",
      url: "https://fixture.invalid/agent",
    });
    await d.refreshTabs();
    expect(d.tabSnapshot().tabs.slice(0, 3)).toEqual(original.tabs);
    expect(d.tabSnapshot().activeTabId).toBe(original.activeTabId);
    await f.activate("agent");
    expect(d.tabSnapshot().activeTabId).toBe(d.tabSnapshot().tabs[3].tabId);
    expect(d.navigation.url).toBe("https://fixture.invalid/agent");
  });
  it("fences queued recovery and tab creation during stop and drains the display sessions", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    f.targets.clear();
    f.sessions[0].navigation!("lost");
    const creating = d.createTab();
    const rejected = expect(creating).rejects.toThrow();
    await d.close();
    await rejected;
    await expect(d.refreshTabs()).rejects.toThrow();
    expect(f.commands.some((x) => x.method === "Target.createTarget")).toBe(
      false,
    );
    expect(f.sessions.every((s) => s.closed)).toBe(true);
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("creates a blank page when the final survivors disappear during recovery", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    f.targets.delete("a");
    f.intercept((method, params) => {
      if (
        method === "Target.activateTarget" &&
        ["b", "c"].includes(String(params.targetId))
      )
        f.targets.delete(String(params.targetId));
    });
    f.sessions[0].navigation!("lost");
    await d.refreshTabs();
    expect(d.tabSnapshot().tabs).toHaveLength(1);
    expect(d.tabSnapshot().tabs[0].url).toBeNull();
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("recovers a newly discovered survivor after the original neighbors disappear", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    f.targets.delete("a");
    f.intercept((method, params) => {
      if (method !== "Target.activateTarget") return;
      const id = String(params.targetId);
      if (["b", "c"].includes(id)) f.targets.delete(id);
      if (id === "c")
        f.targets.set("d", {
          targetId: "d",
          type: "page",
          title: "Survivor",
          url: "https://fixture.invalid/d",
        });
    });
    f.sessions[0].navigation!("lost");
    await d.refreshTabs();
    expect(d.navigation.url).toBe("https://fixture.invalid/d");
    expect(d.tabSnapshot().tabs).toHaveLength(1);
    expect(f.lost).not.toHaveBeenCalled();
    expect(
      f.commands
        .filter((x) => x.method === "Target.activateTarget")
        .map((x) => x.params.targetId),
    ).toEqual(["b", "c", "d"]);
  });
  it("creates a blank page if the newly discovered recovery candidate also disappears", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    f.targets.delete("a");
    f.intercept((method, params) => {
      if (method !== "Target.activateTarget") return;
      const id = String(params.targetId);
      if (["b", "c", "d"].includes(id)) f.targets.delete(id);
      if (id === "c")
        f.targets.set("d", {
          targetId: "d",
          type: "page",
          title: "Transient",
          url: "https://fixture.invalid/d",
        });
    });
    f.sessions[0].navigation!("lost");
    await d.refreshTabs();
    expect(d.tabSnapshot().tabs).toHaveLength(1);
    expect(d.tabSnapshot().tabs[0].url).toBeNull();
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("yields bounded recovery sweeps to further fresh candidates without revoking the show", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    f.targets.delete("a");
    f.intercept((method, params) => {
      if (method !== "Target.activateTarget") return;
      const id = String(params.targetId);
      if (["b", "c", "d"].includes(id)) f.targets.delete(id);
      const next = id === "c" ? "d" : id === "d" ? "e" : null;
      if (next)
        f.targets.set(next, {
          targetId: next,
          type: "page",
          title: next,
          url: "https://fixture.invalid/" + next,
        });
    });
    f.sessions[0].navigation!("lost");
    // No polling: the finite second sweep yields and schedules the fresh e.
    await vi.waitFor(() =>
      expect(d.navigation.url).toBe("https://fixture.invalid/e"),
    );
    expect(f.lost).not.toHaveBeenCalled();
    expect(
      f.commands
        .filter((x) => x.method === "Target.activateTarget")
        .map((x) => x.params.targetId),
    ).toEqual(["b", "c", "d", "e"]);
  });
  it("visits stable failed recovery candidates only once instead of retrying indefinitely", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    f.targets.delete("a");
    f.intercept((method) => {
      if (method === "Target.activateTarget")
        throw Error("Unavailable target session");
    });
    f.sessions[0].navigation!("lost");
    await vi.waitFor(() => expect(f.lost).toHaveBeenCalledOnce());
    expect(
      f.commands
        .filter((x) => x.method === "Target.activateTarget")
        .map((x) => x.params.targetId),
    ).toEqual(["b", "c"]);
    expect(f.commands.some((x) => x.method === "Target.createTarget")).toBe(
      false,
    );
  });
  it("recovers again without polling when a replacement closes while the old capture is draining", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    cleanups.push(() => d.close());
    let finish!: (data: { data: string }) => void;
    f.capture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const frame = d.view.frame(),
      rejected = expect(frame).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    f.targets.delete("a");
    f.targets.delete("c");
    f.sessions[0].navigation!("lost");
    await vi.waitFor(() =>
      expect(d.navigation.url).toBe("https://fixture.invalid/b"),
    );
    f.targets.delete("b");
    f.sessions.find((session) => session.id === "b" && session.navigation)!
      .navigation!("lost");
    f.capture(undefined);
    finish({ data: Buffer.from("retired").toString("base64") });
    await rejected;
    // No refreshTabs() or runtime.state(): recovery must not lose this detach.
    await vi.waitFor(() => {
      const snapshot = d.tabSnapshot();
      expect(snapshot.tabs).toHaveLength(1);
      expect(snapshot.activeTabId).toBe(snapshot.tabs[0].tabId);
      expect(snapshot.tabs[0].url).toBeNull();
    });
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("acknowledges selection and serves new frames before an old background capture retires, but drains retirement at stop", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    let finish: ((data: { data: string }) => void) | undefined,
      releaseRetired: (() => void) | undefined;
    let oldRejected = false;
    f.capture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const oldFrame = d.view.frame().catch(() => {
      oldRejected = true;
    });
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const oldSession = f.sessions.at(-1)!;
      oldSession.closeGate = new Promise<void>((resolve) => {
        releaseRetired = resolve;
      });
      f.capture(undefined);
      let switched = false;
      const selecting = d.selectTab(d.tabSnapshot().tabs[1].tabId).then(() => {
        switched = true;
      });
      await vi.waitFor(() => expect(switched).toBe(true));
      await selecting;
      await d.refreshTabs();
      expect(d.navigation.url).toBe("https://fixture.invalid/b");
      expect((await d.view.frame()).toString()).toBe("b");
      expect(f.sessions[0].closed).toBe(true); // Old navigation retires independently.
      f.sessions[0].navigation!("lost");
      expect(f.lost).not.toHaveBeenCalled();
      let stopped = false;
      const stopping = d.close().then(() => {
        stopped = true;
      });
      await vi.waitFor(() =>
        expect(
          f.sessions
            .filter((session) => session.id === "b")
            .every((session) => session.closed),
        ).toBe(true),
      );
      expect(stopped).toBe(false);
      finish!({ data: Buffer.from("stale old capture").toString("base64") });
      releaseRetired!();
      await Promise.all([stopping, oldFrame]);
      expect(oldRejected).toBe(true);
      expect(f.sessions.every((session) => session.closed)).toBe(true);
    } finally {
      finish?.({ data: Buffer.from("stale old capture").toString("base64") });
      releaseRetired?.();
      await Promise.all([d.close(), oldFrame]);
    }
  });
  it("discards a late frame from the previously selected page and ignores its later detach", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    let finish!: (data: { data: string }) => void;
    f.capture(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const frame = d.view.frame();
    const rejected = expect(frame).rejects.toThrow("заменена");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const switching = f.activate("b");
    await vi.waitFor(() =>
      expect(d.navigation.url).toBe("https://fixture.invalid/b"),
    );
    f.sessions[0].navigation!("lost");
    expect(f.lost).not.toHaveBeenCalled();
    finish({ data: Buffer.from("old-frame").toString("base64") });
    await Promise.all([switching, rejected]);
    f.capture(undefined);
    expect((await d.view.frame()).toString()).toBe("b");
    await d.close();
    expect(f.sessions.every((s) => s.closed)).toBe(true);
  });
  it("survives pipelined closure of the old page while preparing an explicitly activated replacement", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    const switching = f.activate("b");
    // Both responses can arrive in a single Chromium pipe data chunk, before
    // the Promise continuation of selection has even started.
    f.sessions[0].navigation!("lost");
    expect(f.lost).not.toHaveBeenCalled();
    await switching;
    expect(d.navigation.url).toBe("https://fixture.invalid/b");
    expect(f.lost).not.toHaveBeenCalled();
    await d.close();
  });
  it("recovers a surviving page when the pending explicit replacement cannot be selected", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    const switching = f.activate("foreign");
    const rejected = expect(switching).rejects.toThrow();
    f.targets.delete("a");
    f.sessions[0].navigation!("lost");
    expect(f.lost).not.toHaveBeenCalled();
    await rejected;
    await d.refreshTabs();
    expect(d.navigation.url).toBe("https://fixture.invalid/b");
    expect(f.lost).not.toHaveBeenCalled();
    await d.close();
  });
  it("serializes explicit activations, rejects foreign targets and does not resurrect a closed display", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    await Promise.all([f.activate("b"), f.activate("c")]);
    expect(d.navigation.url).toBe("https://fixture.invalid/c");
    await expect(f.activate("foreign")).rejects.toThrow();
    expect(d.navigation.url).toBe("https://fixture.invalid/c");
    const queued = f.activate("a");
    const rejected = expect(queued).rejects.toThrow();
    await d.close();
    await rejected;
    expect(f.sessions.every((s) => s.closed)).toBe(true);
    expect(f.lost).not.toHaveBeenCalled();
  });
  it("focuses the displayed page before user input, but never steals browser focus merely to capture frames", async () => {
    const f = fixture(),
      d = await createPageDisplay(f.pipe, "a", f.lost);
    await d.view.frame();
    const captureSession = f.sessions.at(-1)!;
    expect(captureSession.commands).not.toContain("Page.bringToFront");
    await d.view.scroll(0.5, 0.2, 200);
    const session = f.sessions.at(-1)!;
    expect(session).not.toBe(captureSession);
    expect(session.commands).toEqual([
      "Page.bringToFront",
      "Page.getLayoutMetrics",
      "Input.dispatchMouseEvent",
    ]);
    for (const gesture of [
      () => d.view.text("hi"),
      () => d.view.key("Enter"),
      () => d.view.click(0.5, 0.5),
    ]) {
      session.commands.length = 0;
      await gesture();
      expect(session.commands[0]).toBe("Page.bringToFront");
      expect(
        session.commands.some((method) => method.startsWith("Input.")),
      ).toBe(true);
    }
    await d.close();
  });
});

describe("embedded lease barriers", () => {
  it.each(["handoff", "disconnect"])(
    "drains accepted helper mutations and disposes late transient contexts before %s gives the next agent access",
    async (kind) => {
      const input = new PassThrough(),
        output = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdio: [null, null, null, input, output],
      }) as unknown as ChildProcess;
      let roots = 0;
      input.on("data", (chunk) => {
        for (const raw of chunk.toString().split("\0").filter(Boolean)) {
          const req = JSON.parse(raw);
          const result =
            req.method === "Target.attachToBrowserTarget"
              ? { sessionId: "root-" + ++roots }
              : {};
          output.write(JSON.stringify({ id: req.id, result }) + "\0");
        }
      });
      const contexts = new Set(["persistent"]),
        disposed: string[] = [];
      let entered!: () => void, advance!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        pending = new Promise<void>((r) => (advance = r));
      const control = {
        handles: (m: string) =>
          [
            "Target.createBrowserContext",
            "Target.getBrowserContexts",
            "Target.disposeBrowserContext",
            "Browser.setDownloadBehavior",
          ].includes(m),
        forward: (f: unknown, _n: number, accept: (f: unknown) => void) =>
          accept(f),
        call: async (m: string, p: any) => {
          if (m === "Target.createBrowserContext") {
            entered();
            await pending;
            contexts.add("transient");
            return { browserContextId: "transient" };
          }
          if (m === "Target.disposeBrowserContext") {
            disposed.push(p.browserContextId);
            contexts.delete(p.browserContextId);
            return {};
          }
          if (m === "Target.getBrowserContexts")
            return { browserContextIds: [...contexts] };
          return {};
        },
      };
      let attaching!: () => void,
        admissions = 0;
      const secondAttach = new Promise<void>((r) => {
        attaching = r;
      });
      const pipe = createPipeTarget(child, undefined, control),
        broker = createAgentBroker({
          resolveUpstream: () => {
            if (++admissions === 2) attaching();
            return pipe;
          },
        });
      const port = await freePort();
      const connect = () =>
        new WebSocket("ws://127.0.0.1:" + port + "/devtools/browser");
      await broker.arm("same", port);
      const old = connect();
      let next: WebSocket | undefined;
      try {
        await once(old, "open");
        old.send(
          JSON.stringify({
            id: 1,
            method: "Target.createBrowserContext",
            params: { disposeOnDetach: true },
          }),
        );
        await started;
        const retired = once(old, "close");
        let handed = false;
        const handoff =
          kind === "handoff"
            ? broker.handoff("same", "same").then(() => {
                handed = true;
              })
            : undefined;
        if (!handoff) old.close();
        await retired;
        if (handoff) expect(handed).toBe(false);
        // Even a spontaneous disconnect (without an explicit handoff) must fence
        // the next attached CDP root before outstanding private RPCs are drained.
        if (!handoff) {
          await vi.waitFor(() =>
            expect(broker.state().connectionId).toBeNull(),
          );
          next = connect();
        }
        const opened = next && once(next, "open");
        if (opened) {
          await secondAttach;
          // Flush the admission continuation after the second client's
          // upstream resolves; don't guess socket timing on slow CI.
          await new Promise<void>((r) => setImmediate(r));
        }
        expect(roots).toBe(1);
        advance();
        await handoff;
        if (!next) {
          next = connect();
          await once(next, "open");
        } else await opened;
        expect(disposed).toEqual(["transient"]);
        expect(
          (await ask(next, "Target.getBrowserContexts")).result
            .browserContextIds,
        ).toEqual(["persistent"]);
      } finally {
        advance();
        old.close();
        next?.close();
        await broker.close();
      }
    },
  );
});
describe("private preview cancellation", () => {
  it("cancels only commands of the detached host session without waiting for the browser screenshot timeout", async () => {
    const input = new PassThrough(),
      output = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, input, output],
    }) as unknown as ChildProcess;
    let serial = 0;
    const captures: Array<{ id: number; sessionId: string }> = [];
    const send = (frame: object) => output.write(JSON.stringify(frame) + "\0");
    input.on("data", (chunk) => {
      for (const text of chunk.toString().split("\0").filter(Boolean)) {
        const req = JSON.parse(text);
        if (req.method === "Page.captureScreenshot") captures.push(req);
        else
          send({
            id: req.id,
            result:
              req.method === "Target.attachToTarget"
                ? { sessionId: "host-" + ++serial }
                : {},
          });
      }
    });
    const pipe = createPipeTarget(child),
      a = await pipe.attachHostPage("a"),
      b = await pipe.attachHostPage("b");
    let aRejected = false,
      bSettled = false;
    const old = a.command("Page.captureScreenshot").catch(() => {
      aRejected = true;
    });
    const neighbor = b.command("Page.captureScreenshot").then(
      () => {
        bSettled = true;
      },
      () => {
        bSettled = true;
      },
    );
    try {
      expect(captures).toHaveLength(2);
      await a.close();
      await vi.waitFor(() => expect(aRejected).toBe(true));
      expect(bSettled).toBe(false);
      await expect(b.command("Page.reload")).resolves.toEqual({});
      send({ id: captures[1].id, result: { data: "neighbor" } });
      await neighbor;
      expect(bSettled).toBe(true);
      // A late response for the retired host session is not delivered elsewhere.
      send({ id: captures[0].id, result: { data: "stale" } });
    } finally {
      output.emit("end");
      await Promise.all([old, neighbor, a.close(), b.close()]);
    }
  });
  it("does not begin a wheel/click/text gesture on a retired view after pending focus, metrics or mouse positioning", async () => {
    for (const gate of [
      "Page.bringToFront",
      "Page.getLayoutMetrics",
      "mouseMoved",
    ]) {
      let release!: () => void;
      const calls: string[] = [];
      const pipe = {
        async attachHostPage() {
          return {
            command: async (method: string, params: { type?: string } = {}) => {
              const name = params.type ?? method;
              calls.push(name);
              if (name === gate)
                await new Promise<void>((r) => {
                  release = r;
                });
              if (method === "Page.getLayoutMetrics")
                return {
                  cssVisualViewport: {
                    pageX: 0,
                    pageY: 0,
                    clientWidth: 100,
                    clientHeight: 100,
                  },
                };
              return {};
            },
            close: vi.fn(),
          };
        },
      } as unknown as PipeTarget;
      const view = createLiveView(pipe, { targetId: "A" });
      const action =
        gate === "Page.bringToFront"
          ? view.text("x")
          : gate === "Page.getLayoutMetrics"
            ? view.scroll(0, 0, 10)
            : view.click(0, 0);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const close = view.close(),
        before = calls.slice();
      release();
      await expect(action).rejects.toThrow();
      await close;
      expect(calls).toEqual(before);
    }
  });
  it("cancels the independent capture lane while draining a complete in-flight input gesture", async () => {
    let releasePress: (() => void) | undefined,
      captureStarted = false,
      captureRejected = false;
    const sessions: Array<{
      closed: boolean;
      methods: string[];
      types: string[];
    }> = [];
    const pipe = {
      attachHostPage: async () => {
        const state = {
          closed: false,
          methods: [] as string[],
          types: [] as string[],
        };
        sessions.push(state);
        return {
          command: async (
            method: string,
            params: Record<string, unknown> = {},
          ) => {
            state.methods.push(method);
            if (method === "Page.getLayoutMetrics")
              return {
                cssVisualViewport: {
                  clientWidth: 10,
                  clientHeight: 10,
                  pageX: 0,
                  pageY: 0,
                },
              };
            if (method === "Page.captureScreenshot") {
              captureStarted = true;
              return new Promise(() => {});
            }
            if (method === "Input.dispatchMouseEvent") {
              state.types.push(String(params.type));
              if (params.type === "mousePressed")
                await new Promise<void>((resolve) => {
                  releasePress = resolve;
                });
            }
            return {};
          },
          close: async () => {
            state.closed = true;
          },
        };
      },
    } as unknown as PipeTarget;
    const view = createLiveView(pipe, { targetId: "a" }),
      click = view.click(0.5, 0.5);
    let capture: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(releasePress).toBeTypeOf("function"));
      capture = view.frame().catch(() => {
        captureRejected = true;
      });
      await vi.waitFor(() => expect(captureStarted).toBe(true));
      const closing = view.close();
      await vi.waitFor(() => expect(captureRejected).toBe(true));
      const gesture = sessions.find((session) =>
          session.methods.includes("Input.dispatchMouseEvent"),
        )!,
        screenshot = sessions.find((session) =>
          session.methods.includes("Page.captureScreenshot"),
        )!;
      expect(gesture).not.toBe(screenshot);
      expect(screenshot.closed).toBe(true);
      expect(gesture.closed).toBe(false);
      releasePress!();
      await Promise.all([click, capture, closing]);
      expect(gesture.types).toEqual([
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ]);
      expect(sessions.every((session) => session.closed)).toBe(true);
    } finally {
      releasePress?.();
      await Promise.all([click, capture, view.close()]);
    }
  });
});

describe("live frames bounded demand", () => {
  it("recovers a silent first frame, never queues a second hung snapshot and never publishes a retired fallback into its replacement", async () => {
    const snapshots: Array<ReturnType<typeof vi.fn>> = [];
    const closers: Array<ReturnType<typeof vi.fn>> = [];
    const emitters: Array<
      (frame: { sessionId: number; data: string }) => void
    > = [];
    let finish!: () => void;
    const pipe = {
      async attachHostPage() {
        const shot = vi.fn(
          () =>
            new Promise<object>((resolve) => {
              finish = () =>
                resolve({
                  data: Buffer.from("late old fallback").toString("base64"),
                });
            }),
        );
        const close = vi.fn();
        closers.push(close);
        snapshots.push(shot);
        return {
          close,
          onScreencastFrame: (emit: (typeof emitters)[number]) =>
            emitters.push(emit),
          command: async (method: string) =>
            method === "Page.captureScreenshot"
              ? shot()
              : method === "Page.getLayoutMetrics"
                ? {
                    cssVisualViewport: {
                      pageX: 0,
                      pageY: 0,
                      clientWidth: 20,
                      clientHeight: 10,
                    },
                  }
                : {},
        };
      },
    } as unknown as PipeTarget;
    const view = createLiveView(pipe, { targetId: "mine" });
    vi.useFakeTimers();
    try {
      // Demand persists but Chromium never emits its first frame; fallback
      // is itself stuck. Callers always get a finite heartbeat, not a FIFO.
      for (let i = 0; i < 10; i++) {
        const waiting = view.nextFrame(null);
        await vi.advanceTimersByTimeAsync(800);
        expect(await waiting).toBeNull();
      }
      expect(snapshots[0]).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1700);
      expect(closers[0]).toHaveBeenCalledOnce();
      const next = view.nextFrame(null);
      await vi.advanceTimersByTimeAsync(1);
      finish();
      emitters[1]({
        sessionId: 1,
        data: Buffer.from("new generation").toString("base64"),
      });
      expect((await next)!.pixels.toString()).toBe("new generation");
      await vi.advanceTimersByTimeAsync(1);
      expect((await view.nextFrame(null))!.pixels.toString()).toBe(
        "new generation",
      );
    } finally {
      await view.close();
      vi.useRealTimers();
    }
  });
  it("falls back on demand only for the selected page when screencasting is unsupported or hidden, then prefers the stream again", async () => {
    for (const unsupported of [false, true]) {
      let emit!: (p: { data: string; sessionId: number }) => void,
        visible!: (v: boolean) => void,
        count = 0;
      const pipe = {
        async attachHostPage(id: string) {
          expect(id).toBe("only-this-page");
          return {
            onScreencastFrame: (
              send: typeof emit,
              _lost: () => void,
              vis: typeof visible,
            ) => {
              emit = send;
              visible = vis;
            },
            command: async (method: string) => {
              if (method === "Page.startScreencast" && unsupported)
                throw Object.assign(Error("unknown method"), {
                  protocol: { code: -32601 },
                });
              if (method === "Page.getLayoutMetrics")
                return {
                  cssVisualViewport: {
                    pageX: 0,
                    pageY: 0,
                    clientWidth: 100,
                    clientHeight: 50,
                  },
                };
              if (method === "Page.captureScreenshot")
                return {
                  data: Buffer.from("bounded" + ++count).toString("base64"),
                };
              return {};
            },
            close: vi.fn(),
          };
        },
      } as unknown as PipeTarget;
      const view = createLiveView(pipe, { targetId: "only-this-page" });
      vi.useFakeTimers();
      try {
        const first = view.nextFrame(null);
        await vi.advanceTimersByTimeAsync(1);
        if (!unsupported) {
          emit({ sessionId: 1, data: Buffer.from("live").toString("base64") });
          expect((await first)!.pixels.toString()).toBe("live");
          visible(false);
          emit({
            sessionId: 2,
            data: Buffer.from("late hidden screencast frame").toString(
              "base64",
            ),
          });
        }
        const selected = await first;
        const next = view.nextFrame(selected!.cursor);
        await vi.advanceTimersByTimeAsync(700);
        expect((await next)!.pixels.toString()).toMatch(/^bounded/);
        if (!unsupported) {
          visible(true);
          const previous = await view.nextFrame(null);
          const awaitingVisibleFrame = view.nextFrame(previous!.cursor);
          await vi.advanceTimersByTimeAsync(700);
          expect((await awaitingVisibleFrame)!.pixels.toString()).toMatch(
            /^bounded/,
          );
          emit({
            sessionId: 2,
            data: Buffer.from("again live").toString("base64"),
          });
          expect((await view.nextFrame(null))!.pixels.toString()).toBe(
            "again live",
          );
        }
        const done = count;
        await vi.advanceTimersByTimeAsync(4000);
        expect(count).toBe(done);
      } finally {
        await view.close();
        vi.useRealTimers();
      }
    }
  });
  it("acks on a private session, returns only the latest image, expires idle capture without stopping gestures, and resumes with a fresh cursor", async () => {
    const sessions: Array<{
      emit?: (frame: { data: string; sessionId: number }) => void;
      commands: string[];
      close: ReturnType<typeof vi.fn>;
    }> = [];
    const pipe = {
      async attachHostPage() {
        const s: (typeof sessions)[number] = { commands: [], close: vi.fn() };
        sessions.push(s);
        return {
          onScreencastFrame: (cb: typeof s.emit) => {
            s.emit = cb;
          },
          command: async (method: string) => {
            s.commands.push(method);
            return {};
          },
          close: s.close,
        };
      },
    } as unknown as PipeTarget;
    const v = createLiveView(pipe, { targetId: "a" });
    const send = (n: number, s = sessions[0]) =>
      s.emit!({
        sessionId: n,
        data: Buffer.from("frame" + n).toString("base64"),
      });
    try {
      vi.useFakeTimers();
      const waiting = v.nextFrame(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(sessions[0].commands).toEqual(["Page.startScreencast"]);
      send(1);
      const first = (await waiting)!;
      send(2);
      send(3);
      const latest = (await v.nextFrame(first.cursor))!;
      expect(latest.pixels.toString()).toBe("frame3");
      expect(
        sessions[0].commands.filter((m) => m === "Page.screencastFrameAck"),
      ).toHaveLength(3);
      const heartbeat = v.nextFrame(latest.cursor);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await heartbeat).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      expect(sessions[0].close).toHaveBeenCalledOnce();
      expect(sessions[0].commands).toContain("Page.stopScreencast");
      const resumed = v.nextFrame(latest.cursor);
      await vi.advanceTimersByTimeAsync(0);
      send(9);
      send(4, sessions[1]);
      expect((await resumed)!.pixels.toString()).toBe("frame4");
      expect(
        sessions[0].commands.filter((m) => m === "Page.screencastFrameAck"),
      ).toHaveLength(3);
      const pending = expect(
        v.nextFrame((await v.nextFrame(null))!.cursor),
      ).rejects.toThrow();
      await v.close();
      await pending;
      expect(sessions[1].close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await v.close();
    }
  });
});

describe("page-bound selection and drag", () => {
  function viewFixture() {
    let owns = true,
      changed: (committed: boolean) => void = () => {};
    const commands: any[] = [];
    const dispose = vi.fn(() => {
      changed = () => {};
    });
    const session = {
      command: vi.fn(async (method: string, params: any = {}) => {
        commands.push({ method, params });
        if (method === "Page.getLayoutMetrics")
          return {
            cssVisualViewport: {
              clientWidth: 100,
              clientHeight: 50,
              pageX: 0,
              pageY: 0,
            },
          };
        return {};
      }),
      selection: vi.fn(async () => "selected"),
      close: vi.fn(async () => {}),
    };
    const pipe = {
      attachHostPage: async () => session,
      onDocumentChanged: (_id: string, callback: typeof changed) => {
        changed = callback;
        return dispose;
      },
    } as unknown as PipeTarget;
    const view = createLiveView(pipe, { targetId: "a", ownsPage: () => owns });
    cleanups.push(() => view.close());
    return {
      view,
      session,
      commands,
      dispose,
      retire: () => {
        owns = false;
      },
      navigate: (committed: boolean) => changed(committed),
    };
  }
  it("disposes the navigation watcher exactly once only after delayed gesture/session cleanup", async () => {
    const { view, session, dispose } = viewFixture();
    await view.pointer({
      phase: "down",
      gestureId: "held-disposer",
      x: 0.2,
      y: 0.2,
    });
    let finish!: () => void;
    session.close.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const closing = view.close();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(dispose).not.toHaveBeenCalled();
    const again = view.close();
    expect(dispose).not.toHaveBeenCalled();
    finish();
    await Promise.all([closing, again]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await view.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it("routes a balanced drag only to its own gesture and releases a held button on close", async () => {
    const { view, commands } = viewFixture();
    await view.pointer({
      phase: "down",
      gestureId: "first",
      x: 0.1,
      y: 0.2,
      clickCount: 2,
    });
    await expect(
      view.pointer({ phase: "move", gestureId: "other", x: 0.5, y: 0.5 }),
    ).rejects.toThrow();
    await view.pointer({ phase: "move", gestureId: "first", x: 0.5, y: 0.5 });
    await view.pointer({ phase: "up", gestureId: "first", x: 0.6, y: 0.5 });
    await expect(
      view.pointer({ phase: "move", gestureId: "first", x: 0.7, y: 0.5 }),
    ).rejects.toThrow();
    expect(
      commands
        .filter((c) => c.method === "Input.dispatchMouseEvent")
        .map((c) => c.params),
    ).toEqual([
      { type: "mouseMoved", x: 10, y: 10 },
      {
        type: "mousePressed",
        x: 10,
        y: 10,
        button: "left",
        buttons: 1,
        clickCount: 2,
      },
      { type: "mouseMoved", x: 50, y: 25, button: "left", buttons: 1 },
      {
        type: "mouseReleased",
        x: 60,
        y: 25,
        button: "left",
        buttons: 0,
        clickCount: 2,
      },
    ]);
    await view.pointer({ phase: "down", gestureId: "held", x: 0.1, y: 0.2 });
    await view.close();
    expect(commands.at(-1).params.type).toBe("mouseReleased");
  });
  it("cancels a down awaiting metrics before it can press a mouse button", async () => {
    const { view, session, commands } = viewFixture();
    let release!: () => void;
    let entered = false;
    const original = session.command.getMockImplementation()!;
    session.command.mockImplementation(
      async (method: string, params: any = {}) => {
        if (method === "Page.getLayoutMetrics") {
          entered = true;
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return original(method, params);
      },
    );
    const down = view.pointer({
      phase: "down",
      gestureId: "canceled",
      x: 0.1,
      y: 0.2,
    });
    const outcome = down.catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    const cancel = view.pointer({
      phase: "cancel",
      gestureId: "canceled",
      x: 0.1,
      y: 0.2,
    });
    release();
    await Promise.all([outcome, cancel]);
    expect(commands.some((c) => c.params.type === "mousePressed")).toBe(false);
    await expect(
      view.pointer({ phase: "down", gestureId: "canceled", x: 0.1, y: 0.2 }),
    ).rejects.toThrow();
  });
  it("retires a document's gesture and never releases it in the newly committed document", async () => {
    const { view, commands, navigate } = viewFixture();
    await view.pointer({ phase: "down", gestureId: "old-doc", x: 0.1, y: 0.2 });
    const previous = commands.length;
    navigate(true);
    await expect(
      view.pointer({ phase: "move", gestureId: "old-doc", x: 0.5, y: 0.5 }),
    ).rejects.toThrow();
    await view.close();
    expect(
      commands
        .slice(previous)
        .some((c) => c.method === "Input.dispatchMouseEvent"),
    ).toBe(false);
  });
  it("releases a held pointer before navigation commits and closes its session even when release fails", async () => {
    const { view, session, commands, navigate } = viewFixture();
    await view.pointer({
      phase: "down",
      gestureId: "navigating",
      x: 0.1,
      y: 0.2,
    });
    navigate(false);
    await vi.waitFor(() =>
      expect(commands.at(-1).params.type).toBe("mouseReleased"),
    );
    await view.pointer({ phase: "down", gestureId: "new-doc", x: 0.1, y: 0.2 });
    const original = session.command.getMockImplementation()!;
    session.command.mockImplementation(
      async (method: string, params: any = {}) => {
        if (params.type === "mouseReleased") throw Error("page disappeared");
        return original(method, params);
      },
    );
    await expect(view.close()).rejects.toThrow("page disappeared");
    expect(session.close).toHaveBeenCalled();
    cleanups.pop();
  });
  it("keeps navigation fences while close drains a pending press acknowledgement", async () => {
    const { view, session, commands, navigate } = viewFixture();
    const original = session.command.getMockImplementation()!;
    let release!: () => void,
      entered = false;
    session.command.mockImplementation(
      async (method: string, params: any = {}) => {
        const result = await original(method, params);
        if (params.type === "mousePressed") {
          entered = true;
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return result;
      },
    );
    const pending = view
      .pointer({ phase: "down", gestureId: "press-in-flight", x: 0.2, y: 0.2 })
      .catch(() => {});
    await vi.waitFor(() => expect(entered).toBe(true));
    const closing = view.close();
    const before = commands.length;
    navigate(true);
    release();
    await Promise.all([pending, closing]);
    expect(
      commands.slice(before).some((c) => c.params.type === "mouseReleased"),
    ).toBe(false);
  });
  it("retains an unknown release until acknowledged and refuses a new down meanwhile", async () => {
    const { view, session, commands } = viewFixture();
    await view.pointer({
      phase: "down",
      gestureId: "held-release",
      x: 0.2,
      y: 0.2,
    });
    const original = session.command.getMockImplementation()!;
    session.command.mockImplementation(
      async (method: string, params: any = {}) => {
        if (params.type === "mouseReleased")
          throw Error("release not acknowledged");
        return original(method, params);
      },
    );
    await expect(
      view.pointer({ phase: "up", gestureId: "held-release", x: 0.4, y: 0.4 }),
    ).rejects.toThrow();
    const before = commands.filter(
      (c) => c.params.type === "mousePressed",
    ).length;
    await expect(
      view.pointer({ phase: "down", gestureId: "another", x: 0.3, y: 0.3 }),
    ).rejects.toThrow();
    expect(
      commands.filter((c) => c.params.type === "mousePressed"),
    ).toHaveLength(before);
    session.command.mockImplementation(original);
    await view.close();
    expect(commands.at(-1).params.type).toBe("mouseReleased");
    expect(session.close).toHaveBeenCalled();
  });
  it("clears an abandoned drag after a bounded idle timeout", async () => {
    vi.useFakeTimers();
    const { view, commands } = viewFixture();
    try {
      await view.pointer({
        phase: "down",
        gestureId: "abandoned",
        x: 0.1,
        y: 0.2,
      });
      await vi.advanceTimersByTimeAsync(10000);
      expect(commands.at(-1).params.type).toBe("mouseReleased");
      await expect(
        view.pointer({ phase: "move", gestureId: "abandoned", x: 0.5, y: 0.5 }),
      ).rejects.toThrow();
    } finally {
      await view.close();
      cleanups.pop();
      vi.useRealTimers();
    }
  });
  it("rejects a selection which completed after its page was retired", async () => {
    const { view, session, retire } = viewFixture();
    let release!: (text: string) => void;
    session.selection.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const pending = view.selection();
    await vi.waitFor(() => expect(session.selection).toHaveBeenCalled());
    retire();
    release("must not escape");
    await expect(pending).rejects.toThrow();
  });
  it("retired and foreign runtime selections never read the current page", async () => {
    const runtime = new Demonstrations({ settingsFile: "/not-used-fixture" });
    const read = vi.fn(async () => "mine");
    const entry: any = {
      id: "show",
      published: true,
      closing: false,
      scope: "project",
      browser: { view: { activeTabId: () => "tab", selection: read } },
    };
    (runtime as any).activeShows.set("show", entry);
    await expect(runtime.selection("show", "other")).rejects.toThrow();
    await expect(runtime.selection("foreign", "tab")).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(await runtime.selection("show", "tab")).toBe("mine");
    entry.closing = true;
    await expect(runtime.selection("show", "tab")).rejects.toThrow();
    (runtime as any).activeShows.clear();
    await runtime.close();
  });
});

describe("private selection reader", () => {
  function protocolFixture() {
    const input = new PassThrough(),
      output = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, input, output],
    }) as unknown as ChildProcess;
    const requests: any[] = [];
    let held: any,
      hold = false;
    const send = (m: object) => output.write(JSON.stringify(m) + "\0");
    input.on("data", (chunk) => {
      for (const line of chunk.toString().split("\0").filter(Boolean)) {
        const req = JSON.parse(line);
        requests.push(req);
        let result: any = {};
        if (req.method === "Target.attachToTarget")
          result = { sessionId: "private-selection" };
        if (req.method === "Page.getFrameTree")
          result = {
            frameTree: { frame: { id: "main", loaderId: "document-a" } },
          };
        if (req.method === "Page.createIsolatedWorld")
          result = { executionContextId: 81 };
        if (req.method === "Runtime.evaluate") {
          if (hold) {
            held = req;
            continue;
          }
          result = {
            result: {
              value: {
                kind: "text",
                focused: true,
                text: "plain selected text",
              },
            },
          };
        }
        send({ id: req.id, sessionId: req.sessionId, result });
      }
    });
    const pipe = createPipeTarget(child);
    return {
      pipe,
      requests,
      send,
      hold: () => {
        hold = true;
      },
      held: () => held,
      end: () => output.emit("end"),
    };
  }
  it("reads fixed selection code only in the private isolated world; never opens generic evaluation to the shell", async () => {
    const f = protocolFixture(),
      s = await f.pipe.attachHostPage("page-a");
    try {
      await expect(
        s.command("Runtime.evaluate", { expression: "untrusted" }),
      ).rejects.toThrow();
      expect(await s.selection()).toBe("plain selected text");
      const read = f.requests.find((r) => r.method === "Runtime.evaluate");
      expect(read.params.contextId).toBe(81);
      expect(read.params.expression).toContain("selectionStart");
      expect(read.params.expression).toContain('"password"');
      expect(read.params.expression).not.toContain("untrusted");
      expect(read.sessionId).toBe("private-selection");
      const world = f.requests.find(
        (r) => r.method === "Page.createIsolatedWorld",
      );
      expect(world.params.frameId).toBe("main");
      expect(world.params.grantUniversalAccess).toBeUndefined();
      class Input {
        type = "password";
        selectionStart = 0;
        selectionEnd = 8;
        get value() {
          throw Error("Password contents must never be read");
        }
      }
      const globals = {
        document: { activeElement: new Input(), hasFocus: () => true },
        HTMLInputElement: Input,
        HTMLTextAreaElement: class {},
        getSelection: () => ({ toString: () => "x".repeat(1024 * 1024 + 1) }),
      };
      expect(runInNewContext(read.params.expression, globals).text).toBe("");
      globals.document.activeElement.type = "text";
      globals.document.activeElement.selectionEnd = 1024 * 1024 + 1;
      expect(runInNewContext(read.params.expression, globals).kind).toBe(
        "oversized",
      );
      globals.document.activeElement = null as any;
      const oversized = runInNewContext(read.params.expression, globals);
      expect(oversized.kind).toBe("oversized");
      expect(oversized.text).toBeUndefined();
    } finally {
      await s.close();
      f.end();
    }
  });
  it("rejects a read when that very document navigates before evaluation completes", async () => {
    const f = protocolFixture(),
      s = await f.pipe.attachHostPage("page-a");
    f.hold();
    const pending = s.selection();
    await vi.waitFor(() => expect(f.held()).toBeTruthy());
    const req = f.held();
    f.send({
      method: "Page.frameNavigated",
      sessionId: "private-selection",
      params: { frame: { id: "main", loaderId: "new-document" } },
    });
    f.send({
      id: req.id,
      sessionId: req.sessionId,
      result: {
        result: {
          value: { kind: "text", focused: true, text: "retired document text" },
        },
      },
    });
    try {
      await expect(pending).rejects.toThrow(/изменилась/);
    } finally {
      await s.close();
      f.end();
    }
  });
});
