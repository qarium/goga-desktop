import type {ChildProcess} from 'node:child_process';
export declare function createEmbeddedControl(proc: ChildProcess): { handles(method:string,params:object):boolean; forward(frame: unknown,bytes:number,accept:(frame:unknown)=>void,fail:()=>void):void; call(method:string,params:object):Promise<object> };
