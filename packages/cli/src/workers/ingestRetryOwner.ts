import fs from 'node:fs';
import {InvalidateSync, type InvalidateSyncOptions} from '../invalidateSync.js';
export type TranscriptRetrySource = {client:string;file:string;sessionId:string};
type State = {key:string;source:TranscriptRetrySource;due:number;stopped:boolean;running:boolean;revision:object};
type Registry = {map:Map<string,InvalidateSync>;iterator:MapIterator<[string,InvalidateSync]>};
export class TranscriptRetryOwner {
  private registries:Registry[]=[];
  private states=new WeakMap<InvalidateSync,State>();
  private index=0;
  private stopped=false;
  private draining=false;
  constructor(private options:{allowed:()=>boolean;onMissing?:(source:TranscriptRetrySource)=>void|Promise<void>;onStop?:(source:TranscriptRetrySource)=>void;retryable:(error:unknown)=>boolean;now?:()=>number;wakeDelayMs?:number}){}
  create(map:Map<string,InvalidateSync>,key:string,source:TranscriptRetrySource,run:()=>Promise<void>,options:InvalidateSyncOptions={}):InvalidateSync {
    if(this.stopped)throw new Error('transcript retry owner stopped');
    const identity=JSON.stringify([source.client,source.file,source.sessionId]);
    const existing=map.get(key);
    if(existing){
      if(this.states.get(existing)?.key!==identity)throw new Error('transcript retry source mismatch');
      return existing;
    }
    if(!this.registries.some(r=>r.map===map)){
      if(this.registries.length>=16)throw new Error('transcript retry registry capacity');
      this.registries.push({map,iterator:map.entries()});
    }
    const now=this.options.now??Date.now;
    const state:State={key:identity,source,due:0,stopped:false,running:false,revision:{}};
    const arm=()=>{if(!this.stopped&&!state.stopped){state.revision={};state.due=now()+(this.options.wakeDelayMs??30_000);}};
    const sync=new InvalidateSync(async()=>{
      if(this.stopped||state.stopped)return;
      if(!this.options.allowed()){arm();return;}
      state.running=true;
      const revision=state.revision;
      try{
        try{await fs.promises.stat(source.file);}
        catch(error){
          if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')){
            await this.options.onMissing?.(source);if(state.revision===revision)state.due=0;return;
          }
          throw error;
        }
        if(this.stopped||state.stopped)return;
        if(!this.options.allowed()){arm();return;}
        await run();
        if(state.revision===revision)state.due=0;
      }finally{state.running=false;}
    },{...options,onGiveUp:error=>{
      if(this.options.retryable(error))arm();
      options.onGiveUp?.(error);
    }});
    this.states.set(sync,state);
    const stop=sync.stop.bind(sync);
    sync.stop=()=>{
      if(state.stopped)return;
      state.stopped=true;state.due=0;stop();this.options.onStop?.(source);
    };
    map.set(key,sync);
    return sync;
  }
  drain(maxExamined=64,maxWakes=8):number {
    if(this.stopped||this.draining||!this.options.allowed()||!this.registries.length)return 0;
    this.draining=true;
    try{
      const now=(this.options.now??Date.now)();
      let wakes=0;
      const visited=new Set<InvalidateSync>();
      for(let i=0;i<maxExamined&&wakes<maxWakes;i++){
        const registry=this.registries[this.index++%this.registries.length];
        let entry=registry.iterator.next();
        if(entry.done){registry.iterator=registry.map.entries();entry=registry.iterator.next();}
        if(entry.done)continue;
        const [key,sync]=entry.value,state=this.states.get(sync);
        if(visited.has(sync)||registry.map.get(key)!==sync||!state||state.stopped||state.running||!state.due||state.due>now)continue;
        visited.add(sync);state.due=0;sync.invalidate();wakes++;
      }
      return wakes;
    }finally{this.draining=false;}
  }
  wake(source:TranscriptRetrySource):boolean {
    if(this.stopped)return false;
    let found=false;
    for(const {map} of this.registries) {
      for(const key of [source.file,source.sessionId]) {
        const sync=map.get(key),state=sync&&this.states.get(sync);
        if(!sync||!state||state.stopped||state.source.file!==source.file||state.source.sessionId!==source.sessionId||state.source.client.toLowerCase()!==source.client.toLowerCase())continue;
        found=true;state.revision={};state.due=(this.options.now??Date.now)();
        if(this.options.allowed()){state.due=0;sync.invalidate();}
      }
    }
    return found;
  }
  defer(file:string,sessionId:string):boolean {
    if(this.stopped)return false;
    let found=false;
    for(const {map} of this.registries)for(const key of [file,sessionId]){
      const sync=map.get(key),state=sync&&this.states.get(sync);
      if(!state||state.stopped||state.source.file!==file||state.source.sessionId!==sessionId)continue;
      found=true;state.revision={};state.due=(this.options.now??Date.now)()+(this.options.wakeDelayMs??30_000);
    }
    return found;
  }
  stop():void {
    if(this.stopped)return;
    this.stopped=true;
    for(const {map} of this.registries)for(const sync of map.values())sync.stop();
    this.registries=[];
  }
}
