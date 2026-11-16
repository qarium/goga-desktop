import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const fake = vi.hoisted(() => ({
  created: [] as any[],
  sessions: [] as any[],
  loads: [] as ((url:string)=>Promise<void>)[],
}));
vi.mock("electron", () => ({
  WebContentsView: class extends EventEmitter {
    visible = false;
    bounds = {};
    webContents: any;
    constructor(public options: any) {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        id: fake.created.length + 10,
        loadURL: vi.fn(async (url: string) => {
          this.webContents.url = url;
          const next=fake.loads.shift();if(next)await next(url);
        }),
        url: "",
        getURL: () => this.webContents.url,
        reload: vi.fn(() => queueMicrotask(() => this.webContents.emit("did-finish-load"))),
        isLoadingMainFrame: vi.fn(() => false),
        stop: vi.fn(),
        insertCSS: vi.fn(async () => "style-key"),
        setWindowOpenHandler: vi.fn(),
        setWebRTCIPHandlingPolicy: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
        focus: vi.fn(),
      });
      fake.created.push(this);
    }
    setVisible(v: boolean) {
      this.visible = v;
    }
    setBounds(v: any) {
      this.bounds = v;
    }
  },
  session: {
    fromPartition: vi.fn(() => {
      const s = Object.assign(new EventEmitter(), {
        setPermissionCheckHandler: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        clearStorageData: vi.fn(async () => {}),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn() },
      });
      fake.sessions.push(s);
      return s;
    }),
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  ipcMain: new EventEmitter(),
}));
import { dialog, ipcMain } from "electron";
import { DashboardViews } from "../src/main/views";
import { WindowDashboards } from "../src/main/dashboard-window";
import type { Run } from "../src/shared/types";
describe("independent AFM views", () => {
  beforeEach(() => {
    fake.created.length = 0;
    fake.sessions.length = 0;
    fake.loads.length = 0;
    ipcMain.removeAllListeners("goga:afm-stage-selected");
  });
  function fixture() {
    const win = Object.assign(new EventEmitter(), {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentSize: () => [1280, 900],
      show: vi.fn(),
      focus: vi.fn(),
      isMinimized: () => false,
      restore: vi.fn(),
    });
    const focus = vi.fn(),
      error = vi.fn(),
      shortcut = vi.fn(),
      opened = vi.fn<(_id: string, _url: string) => boolean | Promise<boolean>>(
        () => true,
      );
    return {
      views: new DashboardViews(win as any, focus, error, opened, shortcut),
      win,
      focus,
      error,
      opened,
      shortcut,
    };
  }
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((r, j) => {
      resolve = r;
      reject = j;
    });
    return { promise, resolve, reject };
  }
  describe("window attachment lifecycle with real pin parsing and native generations", () => {
    const origin = "http://localhost:4101";
    const status = (id="run-a") => Response.json({run_id:id,flow_name:"Worker",run_status:"running",stages:[]});
    function setup(runs: Run[] = []) {
      const fetcher = vi.spyOn(globalThis,"fetch").mockImplementation(async()=>status());
      const {views,opened,error} = fixture();
      const host = {
        runCatalog: () => runs,
        withDemonstrationOwner: vi.fn(async (_scope,action)=>action("Owner")),
      };
      const changed=vi.fn();
      const panels = new WindowDashboards(host as any,views,changed);
      opened.mockImplementation((id,url)=>panels.opened(id,url));
      return {panels,views,fetcher,runs,error,changed};
    }
    afterEach(()=>vi.restoreAllMocks());
    it.each(["probe","native","post-load"] as const)("releases the slot and tentative view synchronously when cancelling %s", async phase=>{
      const {panels,fetcher} = setup();
      const heldFetch=deferred<Response>(), heldLoad=deferred<void>();
      if(phase==="probe")fetcher.mockReturnValueOnce(heldFetch.promise);
      if(phase==="native")fake.loads.push(()=>heldLoad.promise);
      if(phase==="post-load")fetcher.mockResolvedValueOnce(status()).mockReturnValueOnce(heldFetch.promise);
      const initial=panels.connect("p",origin,"old");
      const rejected=expect(initial).rejects.toThrow(/отменено/);
      if(phase==="native")await vi.waitFor(()=>expect(fake.created).toHaveLength(1));
      else await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(phase==="probe"?1:2));
      panels.cancel("not-the-owner");
      await expect(panels.connect("p",origin,"blocked")).rejects.toThrow(/выполняется/);
      panels.cancel("old");
      if(phase!=="probe")expect(fake.created[0].webContents.close).toHaveBeenCalledOnce();
      const next=await panels.connect("p",origin,"new");
      expect(next.kind).toBe("attached");
      heldFetch.resolve(status("superseded"));
      heldLoad.resolve();
      await rejected;
      expect(panels.list().length).toBe(1);
      expect(fake.created.at(-1).webContents.close).not.toHaveBeenCalled();
    });
    it("keeps a previously external row observation-only, and deduplicates a previously owned pin", async ()=>{
      const row = {id:"owned",projectId:"p",kind:"pipeline",status:"running",url:origin,dashboardRunId:"run-a",dashboardReconnect:true} as Run;
      const {panels,runs}=setup([row]);
      expect(await panels.connect("p",origin,"managed")).toEqual({kind:"managed",id:"owned"});
      expect(panels.list()).toHaveLength(0);
      expect(fake.created).toHaveLength(0);
      runs.length=0;
      const external = await panels.connect("p",origin,"observer");
      runs.push(row);
      expect(await panels.connect("p",origin,"again")).toEqual(external);
      expect(fake.created).toHaveLength(1);
      expect(panels.list()).toHaveLength(1);
    });
    it.each(["opening","pre-refresh","post-refresh","recovery"] as const)("reports port reuse during %s without publishing a substituted run", async phase=>{
      const {panels,fetcher,views}=setup();
      if(phase==="opening") {
        fetcher.mockResolvedValueOnce(status()).mockResolvedValueOnce(status("run-b"));
        await expect(panels.connect("p",origin,"a")).rejects.toThrow(/другому запуску/);
        expect(panels.list()).toHaveLength(0);
      } else {
        const first = await panels.connect("p",origin,"a");
        if(first.kind!=="attached") throw Error("expected external");
        const id=first.panel.id;
        panels.select("p",id);
        if(phase==="post-refresh")fetcher.mockResolvedValueOnce(status());
        if(phase==="recovery")fake.created[0].webContents.emit("render-process-gone");
        if(phase==="recovery")fetcher.mockResolvedValueOnce(status());
        fetcher.mockResolvedValueOnce(status("run-b"));
        await expect(panels.refresh("p",id,phase==="recovery")).rejects.toThrow(/другому запуску/);
        expect(panels.list()[0].runId).toBe("run-a");
        expect(views.isSelected(id)).toBe(false);
      }
      expect(fake.created.every(page=>!page.visible)).toBe(true);
    });
    it("ignores recovery requested by a hidden tab", async ()=>{
      const {panels,views,fetcher}=setup();
      const result=await panels.connect("p",origin,"a");
      if(result.kind!=="attached")throw Error();
      const page=fake.created[0];
      panels.select("p",result.panel.id);
      page.webContents.emit("render-process-gone");
      views.select(null);
      fetcher.mockClear();
      await expect(panels.refresh("p",result.panel.id,true)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
      expect(fake.created).toHaveLength(1);
    });
    it("a repeated attachment returns its existing tab without starting an uncancellable recovery", async ()=>{
      const {panels}=setup();
      const first=await panels.connect("p",origin,"first");
      fake.created[0].webContents.emit("render-process-gone");
      expect(await panels.connect("p",origin,"duplicate")).toEqual(first);
      expect(fake.created).toHaveLength(1);
    });
    it("a renderer recovery flag cannot leave a healthy but replaced document visible", async ()=>{
      const {panels,views,fetcher}=setup();
      const first=await panels.connect("p",origin,"first");
      if(first.kind!=="attached")throw Error();
      panels.select("p",first.panel.id);
      fetcher.mockResolvedValueOnce(status("new-owner"));
      await expect(panels.refresh("p",first.panel.id,true)).rejects.toThrow(/другому запуску/);
      expect(views.isSelected(first.panel.id)).toBe(false);
      expect(fake.created[0].visible).toBe(false);
    });
  });
  it("checks a managed pin again after reloading if a validator was supplied", async()=>{
    const {views}=fixture();
    views.select("a");
    await views.ensure("a","http://localhost:4101");
    const post=deferred<boolean>();
    const validate=vi.fn().mockResolvedValueOnce(true).mockReturnValueOnce(post.promise);
    const reload=views.refresh("a",validate);
    await vi.waitFor(()=>expect(validate).toHaveBeenCalledTimes(2));
    views.select("a");
    expect(fake.created[0].visible).toBe(false);
    post.resolve(false);
    expect(await reload).toBe(false);
    expect(fake.created[0].visible).toBe(false);
    expect(validate).toHaveBeenCalledTimes(2);
  });
  it("a rejected off-origin navigation cannot poison a healthy retained document", async()=>{
    const {views,error}=fixture();
    await views.ensure("a","http://localhost:4101");
    views.select(null);
    fake.created[0].webContents.emit("did-fail-load",{},-20,"blocked","https://elsewhere.test",true);
    expect(error).not.toHaveBeenCalled();
    views.select("a");
    expect(views.isSelected("a")).toBe(true);
  });
  it("reloads only the selected healthy document, in place, coalescing repeat requests", async () => {
    const {views, opened} = fixture();
    views.reconcile(["one","two"]);
    await views.ensure("one","http://localhost:4101");
    await views.ensure("two","http://localhost:4102");
    views.select("one");
    const wc = fake.created[0].webContents;
    wc.url += "/stages/11#details";
    const validation = deferred<boolean>(), validate = vi.fn(() => validation.promise);
    const first = views.refresh("one", validate);
    expect(views.refresh("one", validate)).toBe(first);
    expect(await views.refresh("two")).toBe(false);
    expect(await views.refresh("unknown")).toBe(false);
    expect(wc.reload).not.toHaveBeenCalled();
    validation.resolve(true);
    expect(await first).toBe(true);
    expect(wc.getURL()).toBe("http://localhost:4101/stages/11#details");
    expect(wc.reload).toHaveBeenCalledOnce();
    expect(wc.loadURL).toHaveBeenCalledOnce();
    expect(fake.created[1].webContents.reload).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(2);
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[0].clearStorageData).not.toHaveBeenCalled();
    expect(fake.created[0].visible).toBe(true);
    wc.url = "http://localhost:4103";
    expect(await views.refresh("one")).toBe(false);
    expect(wc.reload).toHaveBeenCalledOnce();
  });
  it("does not confuse an already pending frame navigation with a requested refresh", async () => {
    const {views} = fixture();
    await views.ensure("a","http://localhost:4101");
    views.select("a");
    const wc = fake.created[0].webContents;
    wc.isLoadingMainFrame.mockReturnValue(true);
    expect(await views.refresh("a")).toBe(false);
    expect(wc.reload).not.toHaveBeenCalled();
  });
  it("does not reload after switching away and back while validation is pending", async () => {
    const {views} = fixture();
    await views.ensure("a","http://localhost:4101");
    views.select("a");
    const pin = deferred<boolean>(), validate = vi.fn(()=>pin.promise);
    const pending = views.refresh("a",validate);
    await vi.waitFor(()=>expect(validate).toHaveBeenCalledOnce());
    views.select(null);
    views.select("a");
    pin.resolve(true);
    expect(await pending).toBe(false);
    expect(fake.created[0].webContents.reload).not.toHaveBeenCalled();
  });
  it("makes a failed reload recoverable without reloading a failed page or affecting a sibling", async () => {
    const {views, error} = fixture();
    views.reconcile(["a","b"]);
    await views.ensure("a","http://localhost:4101");
    await views.ensure("b","http://localhost:4102");
    views.select("a");
    const old = fake.created[0], wc = old.webContents;
    wc.reload.mockImplementationOnce(()=> {
      wc.emit("did-fail-load", {}, -105, "unavailable", wc.url, true);
      wc.emit("did-finish-load");
    });
    expect(await views.refresh("a")).toBe(false);
    expect(error).toHaveBeenCalledExactlyOnceWith("a",expect.any(String));
    expect(old.visible).toBe(false);
    expect(await views.refresh("a")).toBe(false);
    expect(await views.restore("a","http://localhost:4101")).toBe(true);
    wc.emit("did-finish-load");
    expect(old.visible).toBe(false);
    expect(fake.created[2].visible).toBe(true);
    expect(fake.created[1].webContents.reload).not.toHaveBeenCalled();
  });
  it("routes native refresh keys to the selected target only; suppresses browser defaults and repeats", async () => {
    const {views, shortcut} = fixture();
    await views.ensure("a","http://localhost:4101");
    views.select("a");
    const wc = fake.created[0].webContents;
    const press = (key:string, overrides = {}) => {
      const event = {preventDefault:vi.fn()};
      wc.emit("before-input-event",event,{type:"keyDown",key,...overrides});
      return event.preventDefault.mock.calls.length;
    };
    expect(press("F5")).toBe(1);
    expect(press("r",{meta:true})).toBe(1);
    expect(press("R",{control:true})).toBe(1);
    expect(press("R",{meta:true,shift:true})).toBe(1);
    expect(press("F5",{isAutoRepeat:true})).toBe(1);
    expect(press("r")).toBe(0);
    expect(press("r",{control:true,alt:true})).toBe(0);
    views.select(null);
    expect(press("F5")).toBe(1);
    views.remove("a");
    expect(press("F5")).toBe(1);
    expect(shortcut.mock.calls).toEqual([["a"],["a"],["a"],["a"]]);
    expect(wc.reload).not.toHaveBeenCalled();
  });
  it("isolates attached pages without AFM IPC and permits only same-origin HTTP reads", async () => {
    const {views} = fixture(), id = "attached:one", origin = "http://localhost:4101";
    views.reconcile([id]);
    await views.restore(id, origin);
    views.select(id);
    const {options, webContents:wc} = fake.created[0];
    expect(options.webPreferences).toMatchObject({sandbox:true,contextIsolation:true,nodeIntegration:false,devTools:false});
    expect(options.webPreferences).not.toHaveProperty("preload");
    expect(options.webPreferences).not.toHaveProperty("additionalArguments");
    wc.send = vi.fn();
    expect(await views.focusStage(id,"worker")).toBe(false);
    expect(wc.send).not.toHaveBeenCalled();
    const ses = fake.sessions[0], filter = ses.webRequest.onBeforeRequest.mock.calls[0][1];
    expect(wc.setWebRTCIPHandlingPolicy).toHaveBeenCalledExactlyOnceWith("disable_non_proxied_udp");
    expect(ses.setDevicePermissionHandler.mock.calls[0][0]({})).toBe(false);
    const hdr=ses.webRequest.onHeadersReceived.mock.calls[0][0], headerResult=vi.fn();
    hdr({responseHeaders:{"content-type":["text/html"],"Connection-Allowlist":["(response-origin); webrtc=allow"]}},headerResult);
    expect(headerResult.mock.calls[0][0].responseHeaders).toMatchObject({
      "content-type":["text/html"],"Connection-Allowlist":["(response-origin)"],
    });
    const checks: Array<[string, string, boolean]> = [
      [origin+"/api/status","GET",false], [origin+"/style.css","HEAD",false],
      ...["POST","PUT","DELETE","PATCH","OPTIONS"].map(method=>[origin+"/api/action",method,true] as [string,string,boolean]),
      ["ws://localhost:4101/live","GET",true], ["http://localhost:4102/api","GET",true],
      ["https://evil.test/a","GET",true], ["file:///etc/passwd","GET",true],
    ];
    for (const [url,method,cancel] of checks) {
      const cb = vi.fn();
      filter({url,method},cb);
      expect(cb,`${method} ${url}`).toHaveBeenCalledExactlyOnceWith({cancel});
    }
    const download = {preventDefault:vi.fn()};
    ses.emit("will-download",download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    expect(wc.setWindowOpenHandler.mock.calls[0][0]({url:origin})).toEqual({action:"deny"});
    views.remove(id);
    const late = vi.fn();
    filter({url:origin,method:"GET"},late);
    expect(late).toHaveBeenCalledExactlyOnceWith({cancel:true});
  });
  it("revalidates attached identity around reload, hiding the document until confirmed", async () => {
    const {views, error} = fixture(), id = "attached:a", origin = "http://localhost:4101";
    views.reconcile([id]);
    views.select(id);
    expect(await views.restore(id,origin)).toBe(true);
    const page = fake.created[0], pin = deferred<boolean>();
    const validate = vi.fn<()=>Promise<boolean>>().mockResolvedValueOnce(true).mockReturnValueOnce(pin.promise);
    const pending = views.refresh(id, validate);
    await vi.waitFor(()=>expect(validate).toHaveBeenCalledTimes(2));
    expect(page.webContents.reload).toHaveBeenCalledOnce();
    views.select(null);
    views.select(id);
    expect(page.visible).toBe(false);
    pin.resolve(false);
    expect(await pending).toBe(false);
    expect(error).toHaveBeenCalledExactlyOnceWith(id, expect.any(String));
    views.select(id);
    expect(page.visible).toBe(false);
    expect(await views.restore(id,origin)).toBe(true);
    expect(fake.created[1].visible).toBe(true);
    expect(await views.refresh(id)).toBe(false);
    expect(fake.created[1].webContents.reload).not.toHaveBeenCalled();
  });
  it("ignores an external post-refresh check that finishes after detach", async () => {
    const {views, error} = fixture(), id = "attached:a", origin = "http://localhost:4101";
    views.reconcile([id]);
    views.select(id);
    expect(await views.restore(id,origin)).toBe(true);
    const page = fake.created[0], pin = deferred<boolean>();
    const validate = vi.fn<()=>Promise<boolean>>().mockResolvedValueOnce(true).mockReturnValueOnce(pin.promise);
    const pending = views.refresh(id,validate);
    await vi.waitFor(()=>expect(validate).toHaveBeenCalledTimes(2));
    views.remove(id);
    pin.reject(Error("late private details"));
    expect(await pending).toBe(false);
    expect(page.visible).toBe(false);
    expect(error).not.toHaveBeenCalled();
  });
  it("gives up on a hanging observer document and ignores late root navigation", async () => {
    vi.useFakeTimers();
    try {
      const {views, opened} = fixture(), id="attached:timeout", origin="http://localhost:4101";
      const navigation = deferred<void>();
      fake.loads.push(()=>navigation.promise);
      views.reconcile([id]);
      views.select(id);
      const pending = views.restore(id,origin);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fake.created[0].webContents.stop).toHaveBeenCalledOnce();
      expect(await pending).toBe(false);
      navigation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(opened).not.toHaveBeenCalled();
      expect(fake.created[0].visible).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("never reveals a document that changed origin during the opening acknowledgement", async () => {
    const {views, opened} = fixture(), id="attached:late", origin="http://localhost:4101";
    const pin = deferred<boolean>();
    opened.mockReturnValue(pin.promise);
    views.reconcile([id]);
    views.select(id);
    const pending = views.restore(id,origin);
    await vi.waitFor(()=>expect(opened).toHaveBeenCalledOnce());
    fake.created[0].webContents.url = "http://localhost:4102";
    pin.resolve(true);
    expect(await pending).toBe(false);
    expect(fake.created[0].visible).toBe(false);
  });
  it("awaits async browser acknowledgement before revealing a current page", async () => {
    const { views, opened } = fixture();
    const acknowledgement = deferred<boolean>();
    opened.mockReturnValue(acknowledgement.promise);
    views.select("a");
    const loading = views.ensure("a", "http://localhost:4101");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    expect(fake.created[0].visible).toBe(false);
    expect(views.isSelected("a")).toBe(false);
    acknowledgement.resolve(true);
    await loading;
    expect(fake.created[0].visible).toBe(true);
  });
  it("never reveals a page after async acknowledgement rejects or the page fails while waiting", async () => {
    const { views, opened } = fixture();
    const rejected = deferred<boolean>();
    opened.mockReturnValueOnce(rejected.promise);
    views.select("a");
    const loading = views.ensure("a", "http://localhost:4101");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    rejected.resolve(false);
    await loading;
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[0].webContents.close).toHaveBeenCalledOnce();
    const acknowledged = deferred<boolean>();
    opened.mockReturnValueOnce(acknowledged.promise);
    views.select("b");
    const failing = views.ensure("b", "http://localhost:4102");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(2));
    fake.created[1].webContents.emit("render-process-gone");
    acknowledged.resolve(true);
    await failing;
    expect(fake.created[1].visible).toBe(false);
    expect(views.isSelected("b")).toBe(false);
  });
  it("retains healthy pages exactly once when ensuring or restoring the same live run", async () => {
    const { views, opened } = fixture();
    views.reconcile(["a"]);
    const navigation = deferred<void>();
    fake.loads.push(() => navigation.promise);
    const loading = views.ensure("a", "http://localhost:4101");
    const restoring = views.restore("a", "http://localhost:4101");
    navigation.resolve();
    await loading;
    expect(await restoring).toBe(true);
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(1);
    expect(opened).toHaveBeenCalledOnce();
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledOnce();
  });
  it("replaces a failed page without closing the live run or losing selection and viewport", async () => {
    const { views, opened, win } = fixture();
    views.reconcile(["a", "b"]);
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("a");
    views.setViewport({ x: 100, y: 200, width: 1000, height: 650 });
    const failed = fake.created[0];
    failed.webContents.emit("render-process-gone");
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    expect(fake.created).toHaveLength(3);
    expect(failed.webContents.close).toHaveBeenCalledOnce();
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(failed);
    expect(fake.sessions[0].clearStorageData).toHaveBeenCalledOnce();
    const replacement = fake.created[2];
    expect(replacement.visible).toBe(true);
    expect(replacement.bounds).toEqual({
      x: 100,
      y: 200,
      width: 1000,
      height: 650,
    });
    expect(views.isSelected("a")).toBe(true);
    expect(fake.created[1].webContents.close).not.toHaveBeenCalled();
    expect(opened).toHaveBeenCalledTimes(3);
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(3);
  });
  it("single-flights restoration and blocks ensure until old partition cleanup completes", async () => {
    const { views, opened } = fixture();
    views.reconcile(["a"]);
    await views.ensure("a", "http://localhost:4101");
    fake.created[0].webContents.emit("render-process-gone");
    const cleanup = deferred<void>();
    fake.sessions[0].clearStorageData.mockReturnValue(cleanup.promise);
    const first = views.restore("a", "http://localhost:4101");
    const second = views.restore("a", "http://localhost:4101");
    expect(second).toBe(first);
    const ensuring = views.ensure("a", "http://localhost:4101");
    await vi.waitFor(() =>
      expect(fake.sessions[0].clearStorageData).toHaveBeenCalledOnce(),
    );
    expect(fake.created).toHaveLength(1);
    expect(opened).toHaveBeenCalledOnce();
    cleanup.resolve();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    await ensuring;
    expect(fake.created).toHaveLength(2);
    expect(opened).toHaveBeenCalledTimes(2);
  });
  it.each(["remove", "dispose", "reconcile"] as const)(
    "cannot resurrect a restoring page after %s during cleanup",
    async (action) => {
      const { views, opened } = fixture();
      views.reconcile(["a"]);
      await views.ensure("a", "http://localhost:4101");
      fake.created[0].webContents.emit("render-process-gone");
      const cleanup = deferred<void>();
      fake.sessions[0].clearStorageData.mockReturnValue(cleanup.promise);
      const restoring = views.restore("a", "http://localhost:4101");
      await vi.waitFor(() =>
        expect(fake.sessions[0].clearStorageData).toHaveBeenCalledOnce(),
      );
      if (action === "remove") views.remove("a");
      else if (action === "dispose") views.dispose();
      else {
        views.reconcile([]);
        views.reconcile(["a"]);
      }
      cleanup.resolve();
      expect(await restoring).toBe(false);
      await views.ensure("a", "http://localhost:4101");
      expect(fake.created).toHaveLength(1);
      expect(opened).toHaveBeenCalledOnce();
    },
  );
  it.each(["remove", "dispose"] as const)(
    "reports false after %s while replacement load is pending",
    async (action) => {
      const { views, opened } = fixture();
      views.reconcile(["a"]);
      await views.ensure("a", "http://localhost:4101");
      fake.created[0].webContents.emit("render-process-gone");
      const navigation = deferred<void>();
      fake.loads.push(() => navigation.promise);
      const restoring = views.restore("a", "http://localhost:4101");
      await vi.waitFor(() => expect(fake.created).toHaveLength(2));
      if (action === "remove") views.remove("a");
      else views.dispose();
      navigation.resolve();
      expect(await restoring).toBe(false);
      expect(fake.created[1].visible).toBe(false);
      expect(fake.created[1].webContents.close).toHaveBeenCalledOnce();
      expect(opened).toHaveBeenCalledOnce();
    },
  );
  it("ignores an old load and async false acknowledgement after a replacement is current", async () => {
    const { views, opened, error, focus } = fixture();
    views.reconcile(["a"]);
    views.select("a");
    const acknowledgement = deferred<boolean>();
    opened.mockReturnValueOnce(acknowledgement.promise);
    const loading = views.ensure("a", "http://localhost:4101");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const old = fake.created[0];
    old.webContents.emit("render-process-gone");
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    error.mockClear();
    acknowledgement.resolve(false);
    await loading;
    old.webContents.emit("focus");
    old.webContents.emit("dom-ready");
    old.webContents.emit("render-process-gone");
    old.webContents.emit(
      "did-fail-load",
      {},
      -2,
      "failed",
      "http://localhost:4101",
      true,
    );
    expect(error).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(old.webContents.insertCSS).not.toHaveBeenCalled();
    expect(fake.created[1].webContents.close).not.toHaveBeenCalled();
    expect(fake.created[1].visible).toBe(true);
    expect(views.isSelected("a")).toBe(true);
  });
  it("ignores a rejected old navigation after its failed page is replaced", async () => {
    const { views, opened, error } = fixture();
    views.reconcile(["a"]);
    const navigation = deferred<void>();
    fake.loads.push(() => navigation.promise);
    const loading = views.ensure("a", "http://localhost:4101");
    fake.created[0].webContents.emit("render-process-gone");
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    error.mockClear();
    navigation.reject(Error("old navigation aborted"));
    await loading;
    expect(opened).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
  it("cancels old stage acknowledgements before replacement and never accepts them for its new page", async () => {
    const { views } = fixture();
    views.reconcile(["a"]);
    await views.ensure("a", "http://localhost:4101");
    views.select("a");
    const old = fake.created[0].webContents;
    old.mainFrame = { url: "http://localhost:4101" };
    old.send = vi.fn();
    const pending = views.focusStage("a", "worker");
    const oldCommand = old.send.mock.calls[0][1];
    old.emit("render-process-gone");
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    expect(await pending).toBe(false);
    expect(old.send).toHaveBeenLastCalledWith(
      "goga:afm-cancel-stage",
      oldCommand.requestId,
    );
    const current = fake.created[1].webContents;
    current.mainFrame = { url: "http://localhost:4101" };
    current.send = vi.fn();
    const next = views.focusStage("a", "worker");
    const command = current.send.mock.calls[0][1];
    ipcMain.emit(
      "goga:afm-stage-selected",
      { sender: old, senderFrame: old.mainFrame },
      { ...oldCommand, selected: true },
    );
    ipcMain.emit(
      "goga:afm-stage-selected",
      { sender: old, senderFrame: old.mainFrame },
      { ...command, selected: true },
    );
    expect(ipcMain.listenerCount("goga:afm-stage-selected")).toBe(1);
    ipcMain.emit(
      "goga:afm-stage-selected",
      { sender: current, senderFrame: current.mainFrame },
      { ...command, selected: true },
    );
    expect(await next).toBe(true);
    expect(ipcMain.listenerCount("goga:afm-stage-selected")).toBe(0);
  });
  it("reports false when a replacement cannot load or acknowledge its page", async () => {
    const { views, error, opened } = fixture();
    views.reconcile(["a"]);
    await views.ensure("a", "http://localhost:4101");
    fake.created[0].webContents.emit("render-process-gone");
    error.mockClear();
    fake.loads.push(async () => {
      throw Error("replacement refused");
    });
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
    expect(error).toHaveBeenCalledWith("a", expect.any(String));
    expect(opened).toHaveBeenCalledOnce();
    opened.mockResolvedValue(false);
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
    expect(fake.created[2].visible).toBe(false);
    expect(fake.created[2].webContents.close).toHaveBeenCalledOnce();
  });
  it.each(["false", "async false", "rejection"] as const)(
    "allows another live restoration after an acknowledgement %s",
    async (result) => {
      const { views, opened } = fixture();
      views.reconcile(["a"]);
      views.select("a");
      await views.ensure("a", "http://localhost:4101");
      fake.created[0].webContents.emit("render-process-gone");
      opened.mockImplementationOnce(() => {
        if (result === "rejection") return Promise.reject(Error("attempt refused"));
        return result === "async false" ? Promise.resolve(false) : false;
      });
      expect(await views.restore("a", "http://localhost:4101")).toBe(false);
      expect(fake.created[1].visible).toBe(false);
      expect(views.isSelected("a")).toBe(false);
      views.reconcile(["a"]);
      expect(await views.restore("a", "http://localhost:4101")).toBe(true);
      expect(fake.created).toHaveLength(3);
      expect(fake.created[1].webContents.close).toHaveBeenCalledOnce();
      expect(fake.created[2].visible).toBe(true);
      expect(views.isSelected("a")).toBe(true);
      expect(opened).toHaveBeenCalledTimes(3);
    },
  );
  it("does not replace a page when its partition cleanup fails", async () => {
    const { views } = fixture();
    views.reconcile(["a"]);
    await views.ensure("a", "http://localhost:4101");
    fake.created[0].webContents.emit("render-process-gone");
    fake.sessions[0].clearStorageData.mockRejectedValue(
      Error("cleanup failed"),
    );
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
    expect(fake.created).toHaveLength(1);
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(1);
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
    expect(fake.created).toHaveLength(1);
  });
  it("restores only explicitly live nonclosed runs and preserves URL isolation", async () => {
    const { views } = fixture();
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
    views.reconcile(["a", "b"]);
    expect(await views.restore("unknown", "http://localhost:4101")).toBe(false);
    await expect(views.restore("a", "https://evil.test")).rejects.toThrow();
    views.remove("b");
    expect(await views.restore("b", "http://localhost:4102")).toBe(false);
    expect(await views.restore("a", "http://localhost:4101")).toBe(true);
    const page = fake.created[0],
      wc = page.webContents;
    expect(page.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    });
    const event = { preventDefault: vi.fn() };
    wc.emit("will-navigate", event, "https://evil.test");
    wc.emit("will-redirect", event, "https://evil.test");
    wc.emit("will-frame-navigate", { ...event, url: "https://evil.test" });
    wc.emit("will-attach-webview", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(4);
    const filter = fake.sessions[0].webRequest.onBeforeRequest.mock.calls[0][1],
      checked = vi.fn();
    filter({ url: "https://evil.test" }, checked);
    expect(checked).toHaveBeenLastCalledWith({ cancel: true });
    filter({ url: "http://localhost:4101/api" }, checked);
    expect(checked).toHaveBeenLastCalledWith({ cancel: false });
    views.dispose();
    expect(await views.restore("a", "http://localhost:4101")).toBe(false);
  });
  it("fits the measured shell viewport through sidebar collapse and window resize", async () => {
    const { views, win } = fixture();
    await views.ensure("a", "http://localhost:4101");
    views.setViewport({ x: 60, y: 212, width: 1220, height: 688 });
    expect(fake.created[0].bounds).toEqual({
      x: 60,
      y: 212,
      width: 1220,
      height: 688,
    });
    views.select("a");
    expect(fake.created[0].visible).toBe(true);
    views.setViewport({ x: 236, y: 212, width: 1044, height: 688 });
    expect(fake.created[0].bounds.x).toBe(236);
    win.getContentSize = () => [900, 600];
    win.emit("resize");
    expect(fake.created[0].bounds).toEqual({
      x: 236,
      y: 212,
      width: 664,
      height: 388,
    });
    expect(() =>
      views.setViewport({ x: -1, y: 0, width: 10, height: 10 }),
    ).toThrow();
    expect(() =>
      views.setViewport({ x: 0, y: NaN, width: 10, height: 10 }),
    ).toThrow();
    views.setViewport({ x: 1000, y: 1000, width: 500, height: 500 });
    expect(fake.created[0].bounds).toEqual({
      x: 900,
      y: 600,
      width: 0,
      height: 0,
    });
    expect(fake.created[0].options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
  });
  it("inserts new dashboards below any existing native overlay", async () => {
    const { views, win } = fixture();
    const overlay = { kind: "topic-popup" };
    const children: any[] = [overlay];
    win.contentView.addChildView.mockImplementation(
      (view: any, index?: number) => {
        children.splice(index ?? children.length, 0, view);
      },
    );
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    expect(children.at(-1)).toBe(overlay);
    expect(children).toEqual([fake.created[1], fake.created[0], overlay]);
  });
  it("inserts a dashboard above the native shell but below existing dashboards and overlay", async () => {
    const { views, win } = fixture();
    const shellContents = { id: 1 };
    const shellView = { webContents: shellContents };
    const oldDashboard = { kind: "retained-dashboard" };
    const overlay = { kind: "topic-popup" };
    const children: any[] = [shellView, oldDashboard, overlay];
    Object.assign(win, { webContents: shellContents });
    Object.assign(win.contentView, { children });
    win.contentView.addChildView.mockImplementation(
      (view: any, index?: number) => {
        children.splice(index ?? children.length, 0, view);
      },
    );
    await views.ensure("a", "http://localhost:4101");
    expect(children).toEqual([
      shellView,
      fake.created[0],
      oldDashboard,
      overlay,
    ]);
  });
  it("loads once per run and switching preserves independent page state", async () => {
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("a");
    views.select("b");
    views.select("a");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(2);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(fake.created[0].visible).toBe(true);
    expect(fake.created[1].visible).toBe(false);
    views.select(null);
    expect(fake.created.every((v) => !v.visible)).toBe(true);
  });
  it("never gives AFM privileged preload/Node access and refuses untrusted URL", async () => {
    const { views } = fixture();
    await expect(views.ensure("bad", "https://evil.test")).rejects.toThrow();
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created[0].options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(fake.created[0].options.webPreferences.preload).toMatch(
      /afm-preload\.cjs$/,
    );
    expect(fake.created[0].options.webPreferences.additionalArguments).toEqual([
      "--goga-afm-origin=http://localhost:4101",
    ]);
    const popup =
      fake.created[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(popup({ url: "https://evil.test" })).toEqual({ action: "deny" });
  });
  it("hides failed native views so shell diagnostics stay visible", async () => {
    const { views, error } = fixture();
    await views.ensure("a", "http://localhost:4101");
    views.select("a");
    fake.created[0].webContents.emit("render-process-gone");
    expect(error).toHaveBeenCalled();
    expect(fake.created[0].visible).toBe(false);
    views.select("a");
    expect(fake.created[0].visible).toBe(false);
  });
  it("loads without per-run consent and denies browser notifications to avoid duplicate Desktop delivery", async () => {
    vi.mocked(dialog.showMessageBox).mockClear();
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    const check = fake.sessions[0].setPermissionCheckHandler.mock.calls[0][0];
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    expect(check(null, "notifications", "http://localhost:4102")).toBe(false);
    expect(check(null, "camera", "http://localhost:4101")).toBe(false);
    expect(check({ id: 999 }, "notifications", "http://localhost:4101")).toBe(
      false,
    );
  });
  it("denies every permission request before and after close", async () => {
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    const check = fake.sessions[0].setPermissionCheckHandler.mock.calls[0][0];
    const request =
      fake.sessions[0].setPermissionRequestHandler.mock.calls[0][0];
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledOnce();
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    const callback = vi.fn();
    request({ id: fake.created[0].webContents.id }, "notifications", callback, {
      requestingUrl: "http://localhost:4101",
    });
    expect(callback).toHaveBeenLastCalledWith(false);
    views.remove("a");
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    request({ id: fake.created[0].webContents.id }, "notifications", callback, {
      requestingUrl: "http://localhost:4101",
    });
    expect(callback).toHaveBeenLastCalledWith(false);
  });
  it("requires exact AFM main-frame acknowledgement and selected run for stage navigation",async()=>{
    const {views}=fixture();await views.ensure("a","http://localhost:4101");
    expect(await views.focusStage("a","worker")).toBe(false);
    views.select("a");const wc=fake.created[0].webContents;
    wc.mainFrame={url:"http://localhost:4101"};wc.send=vi.fn();
    const pending=views.focusStage("a","worker");
    const command=wc.send.mock.calls[0][1];
    ipcMain.emit("goga:afm-stage-selected",{sender:{id:999},senderFrame:wc.mainFrame},{...command,selected:true});
    ipcMain.emit("goga:afm-stage-selected",{sender:wc,senderFrame:wc.mainFrame},{...command,selected:true});
    expect(await pending).toBe(true);
    expect(ipcMain.listenerCount("goga:afm-stage-selected")).toBe(0);
  });
  it("reapplies narrow AFM branding and theme selectors on each trusted document", async () => {
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    const wc = fake.created[0].webContents;
    wc.emit("dom-ready");
    wc.emit("dom-ready");
    expect(wc.insertCSS).toHaveBeenCalledTimes(2);
    const css = wc.insertCSS.mock.calls[0][0];
    expect(css).toContain("#header.global-header > .gh-left > .gh-mark");
    expect(css).toContain("#header.global-header > .gh-left > .gh-wordmark");
    expect(css).toContain("border-left: 0 !important");
    expect(css).toContain(
      '.gh-right.header-actions > .gh-theme-seg[role="group"][aria-label="Theme mode"]',
    );
    expect(css).not.toContain(".gh-right {");
    wc.url = "http://evil.test";
    wc.emit("dom-ready");
    expect(wc.insertCSS).toHaveBeenCalledTimes(2);
  });
  it("routes page focus back to the correct run and closes views explicitly", async () => {
    const { views, focus } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("b");
    fake.created[0].webContents.emit("focus");
    expect(focus).toHaveBeenCalledWith("a");
    // Renderer must approve navigation before a native view can cover dirty settings.
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[1].visible).toBe(true);
    views.select("a");
    expect(fake.created[0].visible).toBe(true);
    views.select(null);
    fake.created[0].webContents.emit("focus");
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    views.dispose();
    expect(
      fake.created.every((v) => v.webContents.close.mock.calls.length === 1),
    ).toBe(true);
  });
  it("removes only the chosen view and ignores delayed focus/error/ensure", async () => {
    const { views, focus, error, win } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("b");
    views.remove("a");
    views.remove("a");
    expect(fake.created[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(fake.created[1].webContents.close).not.toHaveBeenCalled();
    expect(fake.created[1].visible).toBe(true);
    fake.created[0].webContents.emit("focus");
    fake.created[0].webContents.emit("render-process-gone");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(2);
    expect(focus).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("cannot resurrect after close while browser load is pending", async () => {
    let resolve!: (v: any) => void;
    fake.loads.push(() => new Promise((r) => (resolve = r)));
    const { views, error } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    views.remove("a");
    resolve(undefined);
    await loading;
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    views.dispose();
    await views.ensure("c", "http://localhost:4103");
    expect(fake.created).toHaveLength(1);
  });

  it("rejects stale ensure for a run removed before any page existed", async () => {
    const { views } = fixture();
    views.reconcile(["a"]);
    views.reconcile([]);
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(0);
  });
  it("ignores a rejected pending load and late document callbacks after removal", async () => {
    const { views, error, focus } = fixture();
    let reject!: (e: Error) => void;
    fake.loads.push(() => new Promise((_r: any,j: any)=>(reject=j)));
    const loading = views.ensure("a", "http://localhost:4101");
    await Promise.resolve();
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalled();
    views.remove("a");
    reject(Error("load aborted"));
    await loading;
    fake.created[0].webContents.emit("dom-ready");
    fake.created[0].webContents.emit("focus");
    expect(error).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(fake.sessions[0].clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("acknowledges successful browser load only, keeps loading view hidden and reuses it for journal toggle", async () => {
    const { views, opened } = fixture();
    views.select("a");
    let resolve!: () => void;
    fake.loads.push(() => new Promise<void>(r=>(resolve=r)));
    const loading = views.ensure("a", "http://localhost:4101");
    await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();
    expect(fake.created[0].visible).toBe(false);
    fake.created[0].webContents.url = "http://localhost:4101";
    resolve();
    await loading;
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      "a",
      "http://localhost:4101",
    );
    views.select(null);
    views.select("a");
    views.select(null);
    views.select("a");
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(fake.created[0].visible).toBe(true);
  });
  it("closes pending native load on deadline removal and never acknowledges its late result", async () => {
    let resolve!: (v: any) => void;
    fake.loads.push(() => new Promise((r) => (resolve = r)));
    const { views, opened } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    views.remove("a");
    expect(fake.created[0].webContents.close).toHaveBeenCalledOnce();
    resolve(undefined);
    await loading;
    expect(opened).not.toHaveBeenCalled();
  });
  it("does not reveal a page whose browser acknowledgement is rejected or whose load failed", async () => {
    const { views, opened, error } = fixture();
    opened.mockReturnValue(false);
    views.select("a");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[0].webContents.close).toHaveBeenCalledOnce();
    fake.loads.push(async()=>{throw Error("navigation failed");});
    const loading = views.ensure("b", "http://localhost:4102");
    await loading;
    expect(error).toHaveBeenCalledWith("b", expect.any(String));
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
