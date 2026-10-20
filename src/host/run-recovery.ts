import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { z } from "zod";
import { noSymlinks } from "./settings";
import { childEnvironment } from "./process-environment";

export const runRecoveryMetadataSchema = z
  .object({
    version: z.literal(1),
    runId: z.string().min(1).max(256),
    ownerHash: z.string().regex(/^[a-f0-9]{64}$/),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (v) =>
          path.isAbsolute(v) &&
          path.resolve(v) === v &&
          !/[\x00-\x1f\x7f]/.test(v),
      ),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    rootHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type RunRecoveryMetadata = z.infer<typeof runRecoveryMetadataSchema>;
export type RunProcessMetadata = RunRecoveryMetadata;
export type RunTerminalResult = {
  state: "terminal";
  status: "exited" | "failed" | "stopped";
  endedAt: string;
  code: number | null;
  syncPending: true;
};
export type RunRecoveryResult =
  | { state: "alive" }
  | RunTerminalResult
  | {
      state: "unverified";
      reason:
        | "legacy"
        | "identity-mismatch"
        | "missing-evidence"
        | "unreachable"
        | "group-unverified";
      message: string;
    };
export interface RunRecoveryLaunch {
  runId: string;
  ownerHash: string;
  cwd: string;
  exe: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  journal(metadata: RunRecoveryMetadata): Promise<void>;
}
type Identity = { pid: number; start: string };
type Lease = {
  metadata: RunRecoveryMetadata;
  supervisor: Identity;
  group: Identity;
  phase: "ready" | "started";
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function unverified(
  reason: Extract<RunRecoveryResult, { state: "unverified" }>["reason"],
): RunRecoveryResult {
  const messages = {
    legacy:
      "Старый запуск не содержит проверяемого владельца процесса. Автоматическое снятие блокировки невозможно: после ручного завершения в исходном терминале нужна ручная проверка или миграция журнала. Новый запуск не допускается без доказательства завершения; Desktop не останавливает процессы по PID.",
    "identity-mismatch":
      "Владелец, каталог или идентичность процесса не совпадают. Никакой процесс не остановлен; восстановите исходный контекст и повторите проверку.",
    "missing-evidence":
      "Нет надёжного подтверждения допуска или завершения запуска. Повторите проверку; при отсутствии supervisor проверьте процесс в исходном контексте вручную.",
    unreachable:
      "Supervisor не отвечает. Повторите проверку; Desktop не отправляет сигнал по непроверенному PID.",
    "group-unverified":
      "Осталась группа процессов без подтверждаемого supervisor. Проверьте её в исходном контексте вручную; автоматическая остановка по PID запрещена.",
  };
  return { state: "unverified", reason, message: messages[reason] };
}
async function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "/bin/ps",
      args,
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
      (error, out) => (error ? reject(error) : resolve(out)),
    ),
  );
}
async function identity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  // PID + OS start time is diagnostic identity only: it is NEVER an authority to kill.
  const text = await ps(["-p", String(pid), "-o", "lstart="]).catch(() => "");
  return text.trim() || undefined;
}
async function groupExists(pgid: number): Promise<boolean> {
  const rows = await ps(["-axo", "pid=,pgid=,stat="]);
  const entries = rows.split("\n").map((row) => row.trim().split(/\s+/));
  if (!entries.some(([pid]) => Number(pid) === process.pid))
    throw Error("Не удалось подтвердить таблицу процессов");
  return entries.some(
    ([pid, group, state]) =>
      Number(group) === pgid && Number(pid) > 0 && !state?.startsWith("Z"),
  );
}
function binding(metadata: RunRecoveryMetadata) {
  const { nonce: _nonce, ...value } = metadata;
  return value;
}
function same(a: unknown, b: RunRecoveryMetadata) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Recovery never sends OS signals: only the live guardian can signal its own group. */
export class RunRecoveryManager {
  constructor(private readonly home: string) {}
  private dir(metadata: RunRecoveryMetadata) {
    return path.join(this.home, ".goga/desktop/recovery", metadata.nonce);
  }
  private async directories(metadata: RunRecoveryMetadata, create: boolean) {
    const targets = [
      this.home,
      path.join(this.home, ".goga"),
      path.join(this.home, ".goga/desktop"),
      path.join(this.home, ".goga/desktop/recovery"),
      this.dir(metadata),
    ];
    for (const [index, target] of targets.entries()) {
      await noSymlinks(target);
      if (create && index > 0)
        await mkdir(target, { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
      const st = await lstat(target);
      if (
        !st.isDirectory() ||
        (process.getuid && st.uid !== process.getuid()) ||
        (index >= 3 && st.mode & 0o077)
      )
        throw Error("Небезопасный каталог восстановления запусков");
    }
  }
  private async valid(
    metadata: RunRecoveryMetadata,
    ownerHash: string,
    cwd: string,
  ): Promise<boolean> {
    return (
      !!runRecoveryMetadataSchema.safeParse(metadata).success &&
      metadata.ownerHash === ownerHash &&
      metadata.cwd === cwd &&
      metadata.rootHash === hash(this.home) &&
      (await realpath(cwd).catch(() => "")) === cwd
    );
  }
  private async document(
    metadata: RunRecoveryMetadata,
    file: string,
  ): Promise<unknown | undefined> {
    const target = path.join(this.dir(metadata), file);
    await noSymlinks(target);
    let handle;
    try {
      handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const st = await handle.stat();
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.size > 16384 ||
        st.mode & 0o077 ||
        (process.getuid && st.uid !== process.getuid())
      )
        throw Error("Небезопасная запись восстановления");
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  private async request(
    metadata: RunRecoveryMetadata,
    operation: "query" | "stop",
  ): Promise<unknown> {
    const socket = path.join(this.dir(metadata), "s");
    const st = await lstat(socket);
    if (
      !st.isSocket() ||
      st.mode & 0o077 ||
      (process.getuid && st.uid !== process.getuid())
    )
      throw Error("Небезопасный канал восстановления");
    const lease = (await this.document(metadata, "lease.json")) as Lease;
    if (!lease || !same(lease.metadata, metadata))
      throw Error("Нет проверяемого допуска supervisor");
    const challenge = randomBytes(24).toString("hex");
    const proof = (value: string) =>
      createHmac("sha256", metadata.nonce).update(value).digest("hex");
    const request = {
      binding: binding(metadata),
      operation,
      challenge,
      proof: proof(challenge + "|" + operation),
    };
    return new Promise((resolve, reject) => {
      // Connect relative to the already verified private cwd. UNIX socket sockaddr has a
      // ~104-byte limit on macOS, including otherwise legitimate long HOME paths.
      const helper = spawn(process.execPath, ["-e", CONTROL_SOURCE], {
        cwd: this.dir(metadata),
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
      });
      let buffer = "",
        settled = false;
      const finish = (error: Error | undefined, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(
        () => finish(Error("Supervisor не ответил")),
        2500,
      );
      helper.stdin.on("error", () => {});
      helper.stdout.on("data", (b) => {
        buffer += b;
        if (buffer.length > 16384)
          finish(Error("Некорректный ответ supervisor"));
      });
      helper.once("error", () => finish(Error("Supervisor недоступен")));
      helper.once("close", (code) => {
        try {
          if (code !== 0) throw Error();
          const reply = JSON.parse(buffer);
          const expected = proof(
            challenge +
              "|" +
              operation +
              "|" +
              reply.state +
              "|" +
              JSON.stringify([lease.supervisor, lease.group]),
          );
          if (
            reply.challenge !== challenge ||
            JSON.stringify(reply.binding) !==
              JSON.stringify(binding(metadata)) ||
            JSON.stringify(reply.supervisor) !==
              JSON.stringify(lease.supervisor) ||
            JSON.stringify(reply.group) !== JSON.stringify(lease.group) ||
            typeof reply.proof !== "string" ||
            reply.proof.length !== expected.length ||
            !timingSafeEqual(Buffer.from(reply.proof), Buffer.from(expected))
          )
            throw Error();
          finish(undefined, { metadata, state: reply.state });
        } catch {
          finish(Error("Supervisor не подтвердил идентичность"));
        }
      });
      helper.stdin.end(JSON.stringify(request));
    });
  }
  async launch(options: RunRecoveryLaunch): Promise<{
    child: ChildProcessWithoutNullStreams;
    metadata: RunRecoveryMetadata;
  }> {
    if (process.platform === "win32")
      throw Error(
        "Безопасное восстановление групп процессов поддерживается на macOS и Linux.",
      );
    if (
      (await realpath(this.home)) !== this.home ||
      (await realpath(options.cwd)) !== options.cwd
    )
      throw Error("Каталог запуска должен быть каноническим");
    const metadata = runRecoveryMetadataSchema.parse({
      version: 1,
      runId: options.runId,
      ownerHash: options.ownerHash,
      cwd: options.cwd,
      nonce: randomBytes(16).toString("hex"),
      rootHash: hash(this.home),
    });
    await this.directories(metadata, true);
    // Crucial ordering: no supervisor, guardian or payload exists before this durable callback.
    await options.journal(metadata);
    const child = spawn(process.execPath, ["-e", SUPERVISOR_SOURCE], {
      cwd: this.dir(metadata),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
    });
    child.stdin.on("error", () => {});
    let spawnError = false;
    child.once("error", () => {
      spawnError = true;
    });
    child.stdin.write(
      JSON.stringify({
        metadata,
        dir: this.dir(metadata),
        exe: options.exe,
        args: options.args,
        env: childEnvironment(
          process.env,
          {},
          { ...options.env, NO_COLOR: "1" },
        ),
      }) + "\n",
    );
    const until = Date.now() + 8000;
    for (;;) {
      const lease = (await this.document(metadata, "lease.json").catch(
        () => undefined,
      )) as Lease | undefined;
      if (lease && same(lease.metadata, metadata) && lease.phase === "ready")
        break;
      if (spawnError || child.exitCode !== null || Date.now() > until) {
        child.stdin.end();
        throw Error(
          "Не удалось подготовить безопасный supervisor запуска; повторите проверку записи.",
        );
      }
      await pause(15);
    }
    // The awaiting service gets its streams/listeners before the payload is admitted.
    setImmediate(() => child.stdin.end("go\n"));
    return { child, metadata };
  }
  async reconcile(
    metadata: RunRecoveryMetadata | undefined,
    ownerHash: string,
    cwd: string,
  ): Promise<RunRecoveryResult> {
    if (!metadata) return unverified("legacy");
    if (!(await this.valid(metadata, ownerHash, cwd)))
      return unverified("identity-mismatch");
    try {
      await this.directories(metadata, false);
    } catch {
      return unverified("missing-evidence");
    }
    let receipt: unknown, lease: Lease | undefined;
    try {
      receipt = await this.document(metadata, "receipt.json");
      lease = (await this.document(metadata, "lease.json")) as
        Lease | undefined;
    } catch {
      return unverified("identity-mismatch");
    }
    const receiptSchema = z
      .object({
        metadata: runRecoveryMetadataSchema,
        status: z.enum(["exited", "failed", "stopped"]),
        endedAt: z.string().datetime(),
        code: z.number().int().nullable(),
      })
      .strict();
    if (receipt) {
      const parsed = receiptSchema.safeParse(receipt);
      if (!parsed.success || !same(parsed.data.metadata, metadata))
        return unverified("identity-mismatch");
      return {
        state: "terminal",
        status: parsed.data.status,
        endedAt: parsed.data.endedAt,
        code: parsed.data.code,
        syncPending: true,
      };
    }
    if (!lease) return unverified("missing-evidence");
    const identitySchema = z
      .object({
        pid: z.number().int().positive(),
        start: z.string().min(1).max(128),
      })
      .strict();
    const leaseSchema = z
      .object({
        metadata: runRecoveryMetadataSchema,
        supervisor: identitySchema,
        group: identitySchema,
        phase: z.enum(["ready", "started"]),
      })
      .strict();
    if (!leaseSchema.safeParse(lease).success)
      return unverified("identity-mismatch");
    if (
      !same(lease.metadata, metadata) ||
      !lease.supervisor ||
      !lease.group ||
      !Number.isSafeInteger(lease.group.pid) ||
      lease.group.pid < 1 ||
      typeof lease.group.start !== "string"
    )
      return unverified("identity-mismatch");
    try {
      const reply = (await this.request(metadata, "query")) as {
        metadata: unknown;
        state: string;
      };
      if (!same(reply.metadata, metadata))
        return unverified("identity-mismatch");
      if (reply.state === "alive" || reply.state === "ready")
        return { state: "alive" };
      if (reply.state === "group-unverified")
        return unverified("group-unverified");
      if (reply.state === "terminal")
        return this.reconcile(metadata, ownerHash, cwd);
    } catch {
      /* A missing channel never authorizes a signal. */
    }
    // A normal finish may atomically publish its receipt while the socket request is in flight.
    // Re-read before deriving crash status so a late success receipt wins that race.
    const late = await this.document(metadata, "receipt.json").catch(
      () => undefined,
    );
    if (late) {
      const parsed = receiptSchema.safeParse(late);
      if (!parsed.success || !same(parsed.data.metadata, metadata))
        return unverified("identity-mismatch");
      return {
        state: "terminal",
        status: parsed.data.status,
        endedAt: parsed.data.endedAt,
        code: parsed.data.code,
        syncPending: true,
      };
    }
    const supervisor = await identity(lease.supervisor.pid),
      guardian = await identity(lease.group.pid);
    if (
      (supervisor && supervisor !== lease.supervisor.start) ||
      (guardian && guardian !== lease.group.start)
    )
      return unverified("identity-mismatch");
    // Start receipt proves a real group was admitted. Absence is established by the OS group table,
    // never from an absent lease, absent socket, guessed PID or the supervisor's death alone.
    if (!supervisor && !guardian) {
      try {
        if (await groupExists(lease.group.pid))
          return unverified("group-unverified");
      } catch {
        return unverified("unreachable");
      }
      // Finish/rename can overlap the diagnostics above. A durable receipt is authoritative.
      const finalReceipt = await this.document(metadata, "receipt.json").catch(
        () => undefined,
      );
      if (finalReceipt) {
        const parsed = receiptSchema.safeParse(finalReceipt);
        if (!parsed.success || !same(parsed.data.metadata, metadata))
          return unverified("identity-mismatch");
        return {
          state: "terminal",
          status: parsed.data.status,
          endedAt: parsed.data.endedAt,
          code: parsed.data.code,
          syncPending: true,
        };
      }
      return {
        state: "terminal",
        status: "failed",
        endedAt: new Date().toISOString(),
        code: null,
        syncPending: true,
      };
    }
    return unverified("unreachable");
  }
  async stop(
    metadata: RunRecoveryMetadata,
    ownerHash: string,
    cwd: string,
  ): Promise<RunTerminalResult> {
    const initial = await this.reconcile(metadata, ownerHash, cwd);
    if (initial.state === "terminal") return initial;
    if (initial.state !== "alive") throw Error(initial.message);
    const reply = (await this.request(metadata, "stop")) as {
      metadata: unknown;
      state: string;
    };
    if (!same(reply.metadata, metadata) || reply.state !== "stopping")
      throw Error("Supervisor не подтвердил владельца остановки.");
    const until = Date.now() + 15000;
    do {
      const result = await this.reconcile(metadata, ownerHash, cwd);
      if (result.state === "terminal") return result;
      await pause(30);
    } while (Date.now() < until);
    throw Error(
      "Группа процессов ещё не подтвердила остановку; повторите проверку.",
    );
  }
}

// Only fixed program text appears in argv. Payload argv/environment travel through anonymous pipes.
// The guardian is the live process-group leader. It alone can signal its own group, eliminating
// PID-reuse/TOCTOU signalling races. IPC loss (supervisor crash) triggers the same fail-closed cleanup.
const CONTROL_SOURCE = String.raw`
const net=require('node:net');let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',b=>{input+=b;if(input.length>16384)process.exit(1)});
process.stdin.on('end',()=>{const socket=net.connect('s');let out='';const timer=setTimeout(()=>process.exit(1),1500);
socket.on('connect',()=>socket.end(input));socket.on('data',b=>{out+=b;if(out.length>16384)process.exit(1)});
socket.on('error',()=>process.exit(1));socket.on('end',()=>{clearTimeout(timer);process.stdout.write(out);});});
`;
const SUPERVISOR_SOURCE = String.raw`
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), net=require('node:net'), crypto=require('node:crypto');
const guardianSource='('+function(){
const cp=require('node:child_process');
let payload,stopping=false,started=false;
process.on('SIGTERM',()=>{});
function terminate(){
 if(stopping)return;stopping=true;
 try{process.kill(-process.pid,'SIGTERM')}catch{}
 setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{}},300);
}
process.on('disconnect',terminate);
process.on('message',m=>{
 if(m.operation==='stop'){terminate();return;}
 if(m.operation!=='start'||started||stopping)return;
 started=true;
 try{
 payload=cp.spawn(m.exe,m.args,{cwd:m.cwd,env:m.env,shell:false,detached:false,stdio:['ignore','pipe','pipe']});
 for(const name of ['stdout','stderr']){process[name].on('error',()=>{});payload[name].on('data',b=>{if(!process[name].destroyed)process[name].write(b)});}
 payload.once('error',()=>{if(process.connected)process.send({operation:'outcome',code:null});terminate()});
 payload.once('exit',code=>{if(process.connected)process.send({operation:'outcome',code});terminate()});
 }catch{if(process.connected)process.send({operation:'outcome',code:null});terminate()}
});
process.send({operation:'ready'});
}.toString()+')()';
let input='',cfg,guardian,server,lease,guardianDead=false,started=false,stopped=false,finishing=false,code=null;
for(const name of ['stdout','stderr'])process[name].on('error',()=>{});
function ps(args){try{return cp.execFileSync('/bin/ps',args,{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:['ignore','pipe','ignore']}).trim()}catch{return ''}}
function start(pid){return ps(['-p',String(pid),'-o','lstart='])}
function groupAlive(pid){const table=ps(['-axo','pid=,pgid=,stat=']);const entries=table.split('\n').map(row=>row.trim().split(/\s+/));if(!entries.some(([p])=>Number(p)===process.pid))throw Error('group query failed');return entries.some(([p,g,s])=>Number(g)===pid&&Number(p)>0&&!s?.startsWith('Z'))}
function write(file,data){
 const target=path.join(cfg.dir,file),temp=target+'.tmp';const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 fs.renameSync(temp,target);const dir=fs.openSync(cfg.dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir)}finally{fs.closeSync(dir)}
}
function stop(){stopped=true;if(guardian?.connected)guardian.send({operation:'stop'})}
async function finish(){
 if(finishing)return;finishing=true;
 const deadline=Date.now()+10000;
 while(groupAlive(guardian.pid)){if(Date.now()>deadline){finishing=false;return;}await new Promise(r=>setTimeout(r,25));}
 write('receipt.json',{metadata:cfg.metadata,status:stopped?'stopped':code===0?'exited':'failed',code,endedAt:new Date().toISOString()});
 server.close(()=>process.exit(stopped?0:code===0?0:1));
 setTimeout(()=>process.exit(stopped?0:code===0?0:1),100).unref();
}
function initialize(data){
 cfg=data;
 // Socket's private parent and its fs owner are verified by the manager before every request.
 server=net.createServer(socket=>{
 let text='';socket.on('error',()=>{});socket.on('data',b=>{text+=b;if(text.length>16384)socket.destroy()});
 socket.on('end',()=>{try{
 const q=JSON.parse(text),{nonce,...binding}=cfg.metadata;
 const proof=value=>crypto.createHmac('sha256',nonce).update(value).digest('hex');
 const expected=proof(q.challenge+'|'+q.operation);
 if(!lease||JSON.stringify(q.binding)!==JSON.stringify(binding)||typeof q.challenge!=='string'||q.challenge.length!==48||typeof q.proof!=='string'||q.proof.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(q.proof),Buffer.from(expected)))return socket.end(JSON.stringify({state:'denied'}));
 const state=guardianDead?'group-unverified':q.operation==='stop'?'stopping':started?'alive':'ready';
 const response={binding,challenge:q.challenge,supervisor:lease.supervisor,group:lease.group,state,proof:proof(q.challenge+'|'+q.operation+'|'+state+'|'+JSON.stringify([lease.supervisor,lease.group]))};
 if(q.operation==='stop'&&!guardianDead)stop();socket.end(JSON.stringify(response));
 }catch{socket.destroy()}});
 });
 server.listen('s',()=>fs.chmodSync(path.join(cfg.dir,'s'),0o600));
 guardian=cp.spawn(process.execPath,['-e',guardianSource],{cwd:cfg.metadata.cwd,detached:true,env:{PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe','ipc']});
 for(const name of ['stdout','stderr'])guardian[name].on('data',b=>{if(!process[name].destroyed)process[name].write(b)});
 guardian.on('message',m=>{
 if(m.operation==='ready'){
  lease={metadata:cfg.metadata,supervisor:{pid:process.pid,start:start(process.pid)},group:{pid:guardian.pid,start:start(guardian.pid)},phase:'ready'};
  if(!lease.supervisor.start||!lease.group.start){stop();return;}
  write('lease.json',lease);
  if(input.startsWith('go\n'))admit();
 }else if(m.operation==='outcome')code=m.code;
 });
 guardian.once('error',()=>{process.exitCode=1;server.close()});
 guardian.once('exit',()=>{guardianDead=true;void finish().catch(()=>{process.exitCode=1;server.close()})});
}
function admit(){if(started||!lease)return;started=true;lease.phase='started';write('lease.json',lease);guardian.send({operation:'start',exe:cfg.exe,args:cfg.args,env:cfg.env,cwd:cfg.metadata.cwd});cfg.exe=undefined;cfg.args=undefined;cfg.env=undefined;}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{
 input+=chunk;if(input.length>4*1024*1024){stop();return;}
 if(!cfg){const end=input.indexOf('\n');if(end<0)return;const first=input.slice(0,end);input=input.slice(end+1);try{initialize(JSON.parse(first))}catch{process.exit(1)}}
 if(input.startsWith('go\n'))admit();
});
process.stdin.on('end',()=>{if(!started)stop()});
process.on('SIGTERM',stop);process.on('SIGINT',stop);
`;
