import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {WorkerHost} from './host.js';
import {ingestIdentity} from './ingestJobs.js';
import {IngestAssembler} from './ingestTransport.js';
import {INGEST_PAGE_BYTES,INGEST_PAGE_TOKENS,type IngestJob,type IngestPage} from './ingestTypes.js';
const built=process.env.F3_WORKER_BUILT_DIR;
for(const runtime of ['source','node','bun','compiled']) test.skipIf(runtime!=='source'&&!built)(`${runtime} actual CLI ingest entry reads file and SQLite without daemon boot`,async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'f3-package-')),config=path.join(home,'config');fs.mkdirSync(config);
  const invocation=runtime==='compiled'?{command:path.join(built!,'codecast'),args:['_worker','ingest']}:{command:runtime==='node'?'node':process.execPath,args:[runtime==='source'?path.resolve(import.meta.dir,'../main.ts'):path.join(built!,'js/main.js'),'_worker','ingest']};
  const host=new WorkerHost('ingest',{invocation,env:{...process.env,HOME:home,TMUX_TMPDIR:home,TMUX:'',CODECAST_CONFIG_DIR:config}});
  const read=async(client:IngestJob['client'],file:string,sessionId='full-fixture-id')=>{
    const generation='fixture-generation',job={client,file,sessionId,generation,identity:ingestIdentity(fs.statSync(file)),offset:0};
    let cursor:string|undefined,sequence=0;const a=new IngestAssembler();
    for(;;){const page=await host.request('ingest',cursor?{action:'next',cursor,generation,sequence}:{action:'open',job}) as IngestPage;expect(page.sequence).toBe(sequence++);expect(page.generation).toBe(generation);expect(page.tokens.length).toBeLessThanOrEqual(INGEST_PAGE_TOKENS);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(INGEST_PAGE_BYTES);a.push(page.tokens);if(page.done)break;cursor=page.cursor;}
    return a.finish() as any;
  };
  try {
    const file=path.join(home,'input.jsonl'),text='fixture 🫠 '+ 'a'.repeat(300_000);
    fs.writeFileSync(file,JSON.stringify({type:'user',uuid:'package-id',timestamp:'2026-09-05T12:00:00Z',message:{role:'user',content:text}})+'\n');
    const parsed=await read('claude',file);expect(parsed.messages[0].content).toBe(text);expect(parsed.bytesConsumed).toBe(fs.statSync(file).size);expect(parsed.signatures).toHaveLength(1);expect(parsed.messageTitles).toEqual([text.slice(0,50)+'...']);expect(parsed.handoffParents).toEqual([null]);expect(parsed.metadata.permissionPrompt).toBeNull();expect(host.state.pid).toBeGreaterThan(1);
    const dbFile=path.join(home,'cursor.db'),db=new Database(dbFile);db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs:[{bubbles:[{type:'user',id:'sqlite-id',initText:'SQLite package',contextCacheTimestamp:1000}]}]})]);db.close();
    expect((await read('cursorDb',dbFile)).messages[0].content).toBe('SQLite package');
    const opFile=path.join(home,'opencode.db'),op=new Database(opFile);op.run('CREATE TABLE session(id TEXT,directory TEXT,title TEXT,version TEXT,project_id TEXT,slug TEXT,time_created INTEGER,time_updated INTEGER)');op.run('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');op.run('CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)');op.run("INSERT INTO session VALUES('ses_fixture','/tmp','title','1','p','s',1,2)");op.run('INSERT INTO message VALUES(?,?,?,?)',['m','ses_fixture',1,JSON.stringify({role:'user',time:{created:1}})]);op.run('INSERT INTO part VALUES(?,?,?,?)',['p','m','ses_fixture',JSON.stringify({type:'text',text:'Opencode package'})]);op.close();
    expect((await read('opencode',opFile,'ses_fixture')).messages[0].content).toBe('Opencode package');expect(fs.readdirSync(config)).toEqual([]);expect(fs.existsSync(path.join(home,'.codecast'))).toBe(false);
  } finally {host.close();fs.rmSync(home,{recursive:true,force:true});}
},30_000);
