import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Database} from 'bun:sqlite';
import {WorkerHost} from './host.js';
import {SCAN_PAGE_BYTES,type ScanJob,type ScanPage,type ScanRow} from './scanTypes.js';
const built=process.env.F2_WORKER_BUILT_DIR;
for(const runtime of ['node','bun','compiled'])test.skipIf(!built)(`${runtime} packaged scan runs traversal, inventory, roots, recent, manifests and Cursor observations`,async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'f2-package-'));const config=path.join(home,'config');fs.mkdirSync(config);const write=(rel:string,data='{}\n')=>{const file=path.join(home,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data);return file;};
 for(let i=0;i<270;i++)write(`tree/p/${i}.jsonl`);write('tree/rejected/a.txt');write('.claude/skills/fixture/SKILL.md','---\nname: fixture\ndescription: packaged\n---');const recent=write('.codex/sessions/2026/09/05/rollout-fixture-id.jsonl');fs.mkdirSync(path.join(home,'src/project'),{recursive:true});write('.claude/plugins/installed_plugins.json',JSON.stringify({version:2,plugins:{'fixture@market':[{scope:'user',version:'1'}]}}));write('.claude/plugins/cache/market/fixture/1/.claude-plugin/plugin.json',JSON.stringify({name:'fixture'}));write('.claude/plugins/cache/market/fixture/1/scripts/a.sh','true');write('cursor/workspace.json',JSON.stringify({folder:'file:///tmp/f2-project'}));const dbFile=path.join(home,'cursor/state.vscdb');const db=new Database(dbFile);db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run("INSERT INTO ItemTable VALUES('workbench.panel.aichat.view.aichat.chatdata','{}')");db.run("INSERT INTO ItemTable VALUES('composer.composerData',?)",[JSON.stringify({allComposers:[{composerId:'fixture-composer'}]})]);db.close();
 const host=new WorkerHost('scan',{invocation:{command:runtime==='compiled'?path.join(built!,'codecast'):runtime==='bun'?process.execPath:'node',args:runtime==='compiled'?['_worker','scan']:[path.join(built!,'js/main.js'),'_worker','scan']},env:{...process.env,CODECAST_CONFIG_DIR:config,HOME:home}});
 const scan=async(job:ScanJob)=>{let cursor:string|undefined;const rows:ScanRow[]=[];do{const page=await host.request('scan',cursor?{action:'next',cursor}:{action:'open',job},{timeoutMs:15000}) as ScanPage;expect(page.rows.length).toBeLessThanOrEqual(128);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(SCAN_PAGE_BYTES);rows.push(...page.rows);cursor=page.done?undefined:page.cursor;}while(cursor);return rows;};
 try{
  expect(await scan({name:'walk',root:path.join(home,'tree'),policy:{files:'jsonl'},stats:true})).toHaveLength(270);
  expect((await scan({name:'inventory',home})).some(r=>r.type==='item'&&(r.value as any).name==='fixture')).toBe(true);
  expect(await scan({name:'roots',home,started:[]})).toContainEqual({type:'root',path:path.join(home,'src/project')});
  expect(await scan({name:'recent',home,sessionId:'fixture-id',since:0,codexOnly:true})).toEqual([{type:'recent',path:recent,agentType:'codex'}]);
  expect((await scan({name:'manifests',home})).some(r=>r.type==='manifest')).toBe(true);
  expect(await scan({name:'cursorDatabases',paths:[dbFile]})).toEqual([{type:'cursorDb',path:dbFile,maxRowId:1,workspacePath:'/tmp/f2-project'}]);
  expect(await scan({name:'cursorWorkspace',home,root:home,sessionId:'fixture-composer'})).toEqual([{type:'cursorWorkspace',workspacePath:'/tmp/f2-project'}]);
  expect(await scan({name:'cursorWorkspace',home,root:home,sessionId:'missing'})).toEqual([{type:'cursorWorkspace',workspacePath:null}]);
  expect((await scan({name:'cursorWorkspaces',root:home})).some(row=>row.type==='cursorWorkspaceDb'&&row.path===dbFile)).toBe(true);
  expect(await scan({name:'cursorDatabases',paths:[path.join(home,'absent.vscdb')]})).toEqual([{type:'cursorError',path:path.join(home,'absent.vscdb'),message:expect.any(String),code:'ENOENT'}]);
  expect(fs.readdirSync(config)).toEqual([]);
 }finally{host.close();fs.rmSync(home,{recursive:true,force:true});}
},30000);
