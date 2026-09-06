import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {readTranscriptIngest} from '../ingestClient.js';
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('disappearance cleanup timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
export async function disappearanceReview(f:any) {
  const {d,home,getPosition}=f,internal=d.fixtureCustody,owner=internal.transcriptRetryOwners;
  const cache:any={},pending:any={},sent:any[]=[];let remove:string|undefined,now=Date.now(),givenUp=0;
  owner.options.now=()=>now;
  const receipts=(id:string)=>[...internal.acceptedPending.values()].flatMap((m:any)=>[...m.values()]).filter((r:any)=>r.sessionId===id);
  const sync:any=new Proxy({offloadImages:async()=>{},addMessages:async(p:any)=>{sent.push(p);if(remove){fs.unlinkSync(remove);remove=undefined;}return {ids:p.messages.map((_:any,i:number)=>String(i))};}},{get:(t,k)=>k in t?(t as any)[k]:async()=>true});
  const queue:any={hasPendingConversation:()=>false,getPendingOperations:()=>[],add:()=>{throw new Error('unexpected opaque retry');}};
  const id='disappeared-source',file=path.join(home,id+'.txt');fs.writeFileSync(file,'assistant:\naccepted before disappearance\n');cache[id]='conv-'+id;remove=file;
  const invalidator=owner.create(new Map(),file,{client:'cursor',file,sessionId:id},()=>d.processCursorTranscriptFile(file,id,sync,'user',undefined,cache,queue,pending,()=>{}),{debounceMs:0,maxWaitMs:0,maxRetries:1,onGiveUp:()=>givenUp++});
  await invalidator.invalidateAndAwait();assert.equal(givenUp,1);assert.equal(getPosition(file),0);assert.equal(receipts(id).length,1);assert.equal(sent.length,1);
  const source=fs.readFileSync(path.resolve(import.meta.dir,'../../daemon.ts'),'utf8'),heartbeat=source.match(/setInterval\(\(\) => \{ transcriptRetryOwners\.drain\(\); sendHeartbeat\(\)\.catch\(\(\) => \{\}\); \}, 30_000\);/);assert.ok(heartbeat);
  let timer:ReturnType<typeof setInterval>|undefined;
  const opFile=path.join(home,'.local/share/opencode/opencode.db');fs.mkdirSync(path.dirname(opFile),{recursive:true});const op=new Database(opFile);
  op.run('CREATE TABLE session(id TEXT,directory TEXT,title TEXT,version TEXT,project_id TEXT,slug TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,agent TEXT)');op.run('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');op.run('CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)');
  const opId='ses_disappearance',other='ses_preserved';
  for(const logical of [opId,other]){
    cache[logical]='conv-'+logical;op.run('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)',[logical,home,'title','1','project','slug',1000,2000,null,null]);
    op.run('INSERT INTO message VALUES(?,?,?,?)',[logical+'-m',logical,1000,JSON.stringify({id:logical+'-m',sessionID:logical,role:'user',time:{created:1000}})]);
    op.run('INSERT INTO part VALUES(?,?,?,?)',[logical+'-p',logical+'-m',logical,JSON.stringify({id:logical+'-p',messageID:logical+'-m',sessionID:logical,type:'text',text:logical})]);
  }
  try {
    new Function('setInterval','transcriptRetryOwners','sendHeartbeat',heartbeat[0])((callback:()=>void)=>{timer=setInterval(()=>{now+=30_001;callback();},5);},owner,async()=>{});
    await until(()=>receipts(id).length===0&&!internal.transcriptAckObserved.has(file));await new Promise(resolve=>setTimeout(resolve,20));assert.equal(sent.length,1);assert.equal(givenUp,1);
    const runOp=(logical:string)=>d.processOpencodeSession(logical,sync,'user',undefined,cache,queue,pending,{},()=>{});
    await runOp(opId);assert.equal(internal.opencodeSyncedCounts.get(opId),1);
    for(const logical of [opId,other]){
      const result=await readTranscriptIngest({client:'opencode',file:opFile,sessionId:logical,offset:0});
      await d.retainPendingTranscript(pending,logical,result.messages,opFile,fs.statSync(opFile).size);
      assert.equal(await d.flushPendingTranscript(pending,logical,cache[logical],cache,sync,queue),true);assert.equal(receipts(logical).length,1);
    }
    op.run('DELETE FROM session WHERE id = ?',[opId]);const before=sent.length;await runOp(opId);
    assert.equal(sent.length,before);assert.equal(receipts(opId).length,0);assert.equal(internal.opencodeSyncedCounts.has(opId),false);assert.equal(receipts(other).length,1);assert.ok(fs.existsSync(opFile));
    assert.ok(source.includes('transcriptRetryOwners.stop();'));owner.stop();const stopped=sent.length;invalidator.invalidate();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(sent.length,stopped);assert.equal(owner.drain(),0);
    return {scheduledMissingSource:true,logicalSessionRemoved:true,otherLogicalReceiptPreserved:true,stopped:true};
  } finally {if(timer)clearInterval(timer);owner.stop();op.close();}
}
