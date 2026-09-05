import { expect, test } from 'bun:test';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root=join(import.meta.dir,'../../..');
const parent='jx7297y2rfkpskb14mgbsjm5e58dv709';
async function run(args:string[],config:Record<string,unknown>,env:Record<string,string>={}){
 const dir=mkdtempSync(join(tmpdir(),'agent-origin-cli-'));mkdirSync(join(dir,'.codecast'));
 for(const [name,data] of Object.entries(config))writeFileSync(join(dir,'.codecast',name),JSON.stringify(data));
 try {
  const child=Bun.spawn([process.execPath,'--no-env-file',root+'/packages/cli/src/main.ts','_agent-prompt',...args],{env:{PATH:process.env.PATH,HOME:dir,NODE_ENV:'test',...env},stdin:new Blob(['One\n\nTwo $HOME and `code`.\n']),stdout:'pipe',stderr:'pipe',timeout:5000,killSignal:'SIGKILL'});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,out,err};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
test('real fast path resolves the native ID and preserves a marked multiline prompt',async()=>{
 const r=await run(['--subagent'],{'conversations.json':{native:parent}},{CODEX_THREAD_ID:'native'});expect(r.code).toBe(0);expect(r.err).toBe('');expect(r.out).toBe(`<session-message from="${parent}" subagent="true">\nOne\n\nTwo $HOME and \`code\`.\n</session-message>`);
});
test('managed native thread lookup works without a file watcher cache',async()=>{
 const r=await run([],{'app-server-threads.json':{[parent]:{threadId:'managed'}}},{CODEX_THREAD_ID:'managed'});expect(r.code).toBe(0);expect(r.out).toContain(`from="${parent}"`);expect(r.out).not.toContain('subagent=');
});
test('explicit sender overrides inherited context, while unresolved sender prints no prompt',async()=>{
 const config={'conversations.json':{native:parent}};
 expect((await run(['--from','jx7297y'],config,{CODEX_THREAD_ID:'stale'})).code).toBe(0);
 for(const args of [[],['--from','unknown'],['--from','jx7297y2rfkpskb14mgbsjm5e58dv708'],['--bad']]){
  const r=await run(args,config);expect(r.code).not.toBe(0);expect(r.out).toBe('');
 }
});
