import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  demoIdSchema,
  demoInputSchema,
  type DemoInput,
  type DemoTab,
  type DemoStreamFrame,
} from "../shared/demonstrations";

export type DemoBrowserAction =
  | { op: "reload" }
  | { op: "navigate"; url: string }
  | { op: "tab-create" }
  | { op: "tab-select"; tabId: string }
  | { op: "tab-close"; tabId: string }
  | ({ op: "input"; tabId: string } & DemoInput);
type Options = {
  openExternal: (url: string) => Promise<void>;
  status: (showId: string) => Promise<{
    url: string | null;
    tabs?: DemoTab[];
    activeTabId?: string | null;
  } | null>;
  nextFrame: (
    showId: string,
    tabId: string,
    after: string | null,
  ) => Promise<DemoStreamFrame | null>;
  frame: (showId: string) => Promise<Uint8Array>;
  control: (showId: string, action: DemoBrowserAction) => Promise<unknown>;
  now?: () => number;
};
type Session = {
  show: string;
  expires: number;
  key: string;
  capturing: boolean;
  controlling: boolean;
};
const token = () => randomBytes(24).toString("hex");
const keys = [
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Home",
  "End",
];
function validPng(bytes: Uint8Array): boolean {
  return (
    bytes instanceof Uint8Array &&
    bytes.byteLength >= 24 &&
    bytes.byteLength <= 24 * 1024 * 1024 &&
    Buffer.from(bytes.buffer, bytes.byteOffset, 8).equals(
      Buffer.from("89504e470d0a1a0a", "hex"),
    )
  );
}
function webAddress(raw: unknown): string | null {
  if (
    typeof raw !== "string" ||
    raw.length > 8192 ||
    /[\x00-\x1f\x7f\\]/.test(raw) ||
    !/^https?:\/\/[^/\\?#\s]/i.test(raw.trim())
  )
    return null;
  try {
    const u = new URL(raw);
    return u.username || u.password ? null : u.href;
  } catch {
    return null;
  }
}
function action(value: unknown): DemoBrowserAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const only = (...names: string[]) =>
    names.length === Object.keys(v).length &&
    names.every((k) => Object.hasOwn(v, k));
  if (v.op === "reload" && only("op")) return { op: "reload" };
  if (v.op === "navigate" && only("op", "url")) {
    const url = webAddress(v.url);
    return url ? { op: "navigate", url } : null;
  }
  if (v.op === "tab-create" && only("op")) return { op: "tab-create" };
  if ((v.op === "tab-select" || v.op === "tab-close") && only("op", "tabId")) {
    const id = demoIdSchema.safeParse(v.tabId);
    return id.success ? { op: v.op, tabId: id.data } : null;
  }
  if (v.op !== "input") return null;
  const { op: _, tabId, ...input } = v;
  const id = demoIdSchema.safeParse(tabId);
  if (!id.success) return null;
  const parsed = demoInputSchema.safeParse(input);
  return parsed.success
    ? { op: "input", tabId: id.data, ...parsed.data }
    : null;
}
const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Демонстрация · Goga Desktop</title><link rel="stylesheet" href="viewer.css"><main><header><h1>Демонстрация</h1><span id="message" role="status">Подключаемся к показу…</span></header><div class="tab-strip"><div id="tabs" role="tablist" aria-label="Вкладки страниц"></div><button type="button" id="new-tab" aria-label="Новая вкладка" title="Новая вкладка">+</button></div><form><button type="button" id="reload">Обновить страницу</button><label for="address">Адрес страницы</label><input id="address" autocomplete="off" spellcheck="false" placeholder="https://"><button>Перейти</button></form><img id="frame" tabindex="0" alt="Интерактивная область показа"><p>Нажмите на показ, чтобы управлять страницей с клавиатуры. Escape возвращает к адресу.</p></main><script src="viewer.js" defer></script></html>`;
const css = `*{box-sizing:border-box}body{margin:0;background:#10151c;color:#ecf1f7;font:15px/1.45 system-ui,sans-serif}main{width:min(100%,1550px);margin:auto;padding:18px}header,form{display:flex;align-items:center;gap:10px;flex-wrap:wrap}header{justify-content:space-between}h1{font-size:21px;margin:0}p,#message{color:#b5c6d7}form{margin:15px 0}input,button{font:inherit;border:1px solid #485766;background:#1e2936;color:inherit;border-radius:6px;padding:6px 10px}input{flex:1;min-width:120px}button{cursor:pointer}img{display:block;width:auto;max-width:100%;height:auto;max-height:76vh;margin:auto}img:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #64d7cc}.tab-strip,#tabs,.tab{display:flex;align-items:center;gap:4px}.tab-strip{margin-top:15px}#tabs{flex:1;min-width:0;overflow-x:auto}.tab{flex:none;border:1px solid #485766;border-radius:6px;max-width:300px}.tab button{border:0;background:transparent}.tab [role=tab]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:70px}.tab:has([aria-selected=true]){background:#294651;border-color:#64d7cc}.tab-close{padding:6px 8px}#new-tab{flex:none}`;
const js = `'use strict';
const image=document.querySelector('#frame'),field=document.querySelector('#address'),message=document.querySelector('#message');
let active=true,dirty=false,current='',previousImage='',tail=Promise.resolve(),queued=0,tabSignature='',currentTabId=null;
function renderTabs(status){
  const tabs=Array.isArray(status.tabs)?status.tabs:[],signature=JSON.stringify([tabs,status.activeTabId]);if(signature===tabSignature)return;tabSignature=signature;
  const list=document.querySelector('#tabs');list.replaceChildren();
  for(const tab of tabs){
    const item=document.createElement('div'),select=document.createElement('button'),close=document.createElement('button'),title=tab.title||'Новая вкладка';item.className='tab';
    select.type=close.type='button';select.setAttribute('role','tab');select.setAttribute('aria-selected',String(tab.tabId===status.activeTabId));select.textContent=title;select.title=tab.url||title;select.onclick=()=>{dirty=false;send({op:'tab-select',tabId:tab.tabId});};
    close.className='tab-close';close.textContent='×';close.setAttribute('aria-label','Закрыть вкладку '+title);close.onclick=()=>{dirty=false;send({op:'tab-close',tabId:tab.tabId});};item.append(select,close);list.append(item);
  }
}
function ended(){active=false;message.textContent='Этот показ завершён. Вернитесь в Goga Desktop.';document.querySelectorAll('button,input').forEach(x=>x.disabled=true);image.removeAttribute('src');if(previousImage)URL.revokeObjectURL(previousImage);}
async function call(path,opts={}){const r=await fetch(path,{cache:'no-store',credentials:'same-origin',...opts});if([403,410].includes(r.status)){ended();throw Error();}if(!r.ok)throw Error();return r;}
// Metadata updates do not pace the image: each visible viewer pulls the latest
// available frame, with at most one request/decode in flight.
let cursor=null,generation=0,pulling=false;
function clearPage(){
  generation++;cursor=null;
  image.removeAttribute('src');
  if(previousImage)URL.revokeObjectURL(previousImage);
  previousImage='';
}
async function pull(){
  if(pulling||!active||document.hidden||!currentTabId)return;
  pulling=true;const version=generation,tab=currentTabId;
  const valid=()=>active&&!document.hidden&&generation===version&&tab===currentTabId;
  let delay=0,src='';
  try{
    const headers={'x-demo-tab':tab};if(cursor)headers['x-demo-after']=cursor;
    const r=await call('next',{headers});
    if(r.status===204||!valid())return;
    const next=r.headers.get('x-demo-cursor');
    if(!next||next===cursor)throw Error();
    src=URL.createObjectURL(await r.blob());
    if(!valid())return;
    const decoded=new Image();decoded.src=src;await decoded.decode();
    if(!valid())return;
    image.src=src;if(previousImage)URL.revokeObjectURL(previousImage);
    previousImage=src;src='';cursor=next;message.textContent='Идёт показ';
  }catch{if(valid()){message.textContent='Кадр пока недоступен.';delay=350;}}
  finally{
    if(src)URL.revokeObjectURL(src);
    pulling=false;if(active&&!document.hidden&&currentTabId)setTimeout(pull,delay);
  }
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearPage();else void pull();});
async function update(){if(!active)return;if(!document.hidden)try{
  const status=await (await call('status')).json(),nextTabId=status.activeTabId??null;
  if(nextTabId!==currentTabId){clearPage();dirty=false;currentTabId=nextTabId;void pull();}
  current=status.url||'';if(!dirty)field.value=current;renderTabs(status);
}catch{if(active)message.textContent='Показ пока недоступен.';}if(active)setTimeout(update,450);}
function send(payload){if(!active||queued>=24)return;
  if(payload.op==='input'){
    if(document.hidden||!previousImage||!currentTabId)return;
    payload={...payload,tabId:currentTabId};
  }
  queued++;tail=tail.then(()=>call('control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).catch(()=>{if(active)message.textContent='Не удалось выполнить действие.';}).finally(()=>queued--);}
field.oninput=()=>dirty=true;field.onblur=()=>{if(dirty){dirty=false;field.value=current;}};
field.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();dirty=false;field.value=current;field.blur();}};
document.querySelector('form').onsubmit=e=>{e.preventDefault();const url=field.value;dirty=false;send({op:'navigate',url});};
document.querySelector('form button:not([type])').onmousedown=e=>e.preventDefault();
document.querySelector('#reload').onclick=()=>send({op:'reload'});
document.querySelector('#new-tab').onclick=()=>{dirty=false;send({op:'tab-create'});};
function point(e){const b=image.getBoundingClientRect();return {x:Math.min(1,Math.max(0,(e.clientX-b.left)/b.width)),y:Math.min(1,Math.max(0,(e.clientY-b.top)/b.height))};}
image.onclick=e=>{image.focus();send({op:'input',action:'click',...point(e)});};
image.addEventListener('wheel',e=>{e.preventDefault();send({op:'input',action:'scroll',...point(e),deltaY:Math.min(2000,Math.max(-2000,e.deltaY))});},{passive:false});
image.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();field.focus();return;}if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing)return;if(${JSON.stringify(keys)}.includes(e.key)){e.preventDefault();send({op:'input',action:'key',key:e.key});}else if([...e.key].length===1){e.preventDefault();send({op:'input',action:'text',text:e.key});}};
update();`;

export function createDemoBrowser(d: Options) {
  const tickets = new Map<string, { show: string; expires: number }>(),
    sessions = new Map<string, Session>();
  const now = d.now ?? Date.now;
  let address: Promise<string> | undefined,
    origin = "",
    closed = false;
  function expire() {
    for (const m of [sessions, tickets])
      for (const [k, v] of m) if (v.expires <= now()) m.delete(k);
  }
  const reply = (
    res: ServerResponse,
    status: number,
    type = "text/plain; charset=utf-8",
    body: string | Uint8Array = "",
  ) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(body);
  };
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 7000 },
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
      void handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 503);
        else res.destroy();
      });
    },
  );
  server.maxConnections = 80;
  async function handle(req: IncomingMessage, res: ServerResponse) {
    expire();
    if (
      closed ||
      !origin ||
      req.headers.host !== new URL(origin).host ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      (req.headers.origin !== undefined && req.headers.origin !== origin)
    )
      return reply(res, 403);
    const path = req.url || "",
      ticket = /^\/open\/([0-9a-f]{48})$/.exec(path);
    if (ticket && req.method === "GET") {
      const entry = tickets.get(ticket[1]);
      tickets.delete(ticket[1]);
      if (!entry) return reply(res, 403);
      if (!(await d.status(entry.show)) || closed) return reply(res, 410);
      if (entry.expires <= now()) return reply(res, 403);
      if (sessions.size >= 64) return reply(res, 429);
      const route = token(),
        key = token(),
        prefix = "/v/" + route + "/";
      sessions.set(route, {
        key,
        show: entry.show,
        expires: now() + 4 * 60 * 60 * 1000,
        capturing: false,
        controlling: false,
      });
      res.setHeader(
        "Set-Cookie",
        "demo_view=" + key + "; Path=" + prefix + "; HttpOnly; SameSite=Strict",
      );
      res.setHeader("Location", prefix);
      return reply(res, 303);
    }
    const match =
      /^\/v\/([0-9a-f]{48})\/(|viewer\.js|viewer\.css|status|frame|next|control)$/.exec(
        path,
      );
    if (!match) return reply(res, 404);
    const [, route, resource] = match,
      s = sessions.get(route);
    if (
      !s ||
      !(req.headers.cookie || "")
        .split(";")
        .some((c) => c.trim() === "demo_view=" + s.key)
    )
      return reply(res, 403);
    const live = async () => {
      const result = await d.status(s.show);
      if (
        !result ||
        s.expires <= now() ||
        sessions.get(route) !== s ||
        closed
      ) {
        sessions.delete(route);
        return null;
      }
      return result;
    };
    if (resource === "control") {
      if (
        req.method !== "POST" ||
        req.headers.origin !== origin ||
        req.headers["content-type"]?.split(";")[0] !== "application/json"
      )
        return reply(res, 403);
      if (Number(req.headers["content-length"]) > 24 * 1024)
        return reply(res, 413);
      if (s.controlling) return reply(res, 429);
      s.controlling = true;
      try {
        let size = 0;
        const parts: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 24 * 1024) return reply(res, 413);
          parts.push(chunk);
        }
        let a: DemoBrowserAction | null = null;
        try {
          a = action(JSON.parse(Buffer.concat(parts).toString("utf8")));
        } catch {}
        if (!a || (a.op === "navigate" && new URL(a.url).origin === origin))
          return reply(res, 400);
        const state = await live();
        if (!state) return reply(res, 410);
        if (
          (a.op === "tab-select" || a.op === "tab-close") &&
          !state.tabs?.some((tab) => tab.tabId === a.tabId)
        )
          return reply(res, 400);
        if (a.op === "input" && a.tabId !== state.activeTabId)
          return reply(res, 400);
        await d.control(s.show, a);
        return reply(res, 204);
      } finally {
        s.controlling = false;
      }
    }
    if (req.method !== "GET") return reply(res, 405);
    if (resource === "next") {
      const tab = demoIdSchema.safeParse(req.headers["x-demo-tab"]),
        after = demoIdSchema
          .nullable()
          .safeParse(req.headers["x-demo-after"] ?? null);
      if (!tab.success || !after.success) return reply(res, 400);
      if (s.capturing) return reply(res, 429);
      s.capturing = true;
      try {
        // The session owns the show; only the host resolves the opaque tab.
        // nextFrame checks its active page before and after the wait. No
        // catalog refresh (and no Target.getTargets) is needed per frame.
        const next = await d.nextFrame(s.show, tab.data, after.data);
        if (closed || sessions.get(route) !== s || s.expires <= now())
          return reply(res, 410);
        if (!next) return reply(res, 204);
        if (
          !demoIdSchema.safeParse(next.cursor).success ||
          !validPng(next.pixels)
        )
          return reply(res, 503);
        res.setHeader("X-Demo-Cursor", next.cursor);
        return reply(res, 200, "image/png", next.pixels);
      } finally {
        s.capturing = false;
      }
    }
    const state = await live();
    if (!state) return reply(res, 410);
    if (!resource) return reply(res, 200, "text/html; charset=utf-8", html);
    if (resource === "viewer.css")
      return reply(res, 200, "text/css; charset=utf-8", css);
    if (resource === "viewer.js")
      return reply(res, 200, "text/javascript; charset=utf-8", js);
    if (resource === "status")
      return reply(
        res,
        200,
        "application/json",
        JSON.stringify({
          url: webAddress(state.url),
          ...(state.tabs
            ? {
                tabs: state.tabs.map((tab) => ({
                  tabId: tab.tabId,
                  title: tab.title,
                  url: webAddress(tab.url),
                })),
                activeTabId: state.activeTabId ?? null,
              }
            : {}),
        }),
      );
    if (s.capturing) return reply(res, 429);
    s.capturing = true;
    try {
      const bytes = await d.frame(s.show);
      if (!(await live())) return reply(res, 410);
      if (!validPng(bytes)) return reply(res, 503);
      return reply(res, 200, "image/png", bytes);
    } finally {
      s.capturing = false;
    }
  }
  function listen() {
    return (address ??= new Promise<string>((resolve, reject) => {
      const onError = () => {
        address = undefined;
        reject(Error("Не удалось подготовить браузерный просмотр."));
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
        resolve(origin);
      });
    }));
  }
  async function open(showId: string) {
    if (closed || !showId || !(await d.status(showId)) || closed)
      throw Error("Этот показ завершён.");
    const base = await listen();
    expire();
    if (closed || tickets.size >= 64)
      throw Error("Не удалось открыть просмотр.");
    const k = token();
    tickets.set(k, { show: showId, expires: now() + 45000 });
    try {
      await d.openExternal(base + "/open/" + k);
    } catch {
      tickets.delete(k);
      throw Error("Не удалось открыть внешний браузер.");
    }
  }
  async function close() {
    closed = true;
    tickets.clear();
    sessions.clear();
    if (address) await address.catch(() => {});
    if (server.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
  return { open, close };
}
