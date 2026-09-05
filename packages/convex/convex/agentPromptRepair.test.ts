import { expect, test } from 'bun:test';
import { repair } from './agentPromptRepair';
import { makeFakeDb } from './testDb';
import { buildExistingMessagePatch } from './messages';
import { parseInboundSessionMessage } from '../../web/components/sessionMessage';
const parent='jx7297y2rfkpskb14mgbsjm5e58dv709';
function fixture() {
 const original={_id:'target',conversation_id:'child',message_uuid:'stable-uuid',role:'user',content:'Exact body\n`code` and café',timestamp:120,images:[{data:'preserved'}]};
 const db=makeFakeDb({message_search_recent:[{_id:'mirror',message_id:'target',content:original.content}],conversations:[{_id:parent,user_id:'owner'},{_id:'child',user_id:'owner',parent_conversation_id:parent,is_subagent:true,transcript_revision:2,updated_at:999}],messages:[original,{_id:'source',conversation_id:parent,role:'assistant',timestamp:125,tool_calls:[{id:'call',input:'{"command":"agent-send.sh worker prompt"}'}]}]});
 const args={parent_conversation_id:parent,child_conversation_id:'child',entries:[{message_id:'target',expected_content:original.content,source_message_id:'source',source_call_id:'call',expected_source_input:'{"command":"agent-send.sh worker prompt"}'}]};
 return {db,args,original:{...original},run:(input:any=args)=>(repair as any)._handler({db},input)};
}
test('repair defaults to preview, then changes only attribution and remains idempotent across re-import',async()=>{
 const f=fixture();expect(await f.run()).toEqual({dry_run:true,changed:1});expect(await f.db.get('target')).toEqual(f.original);
 expect(await f.run({...f.args,dry_run:false})).toEqual({dry_run:false,changed:1});
 const target=await f.db.get('target');expect({...target,content:f.original.content}).toEqual(f.original);
 expect(parseInboundSessionMessage(target.content)).toEqual({from:parent,body:f.original.content,name:undefined});
 expect(target.content).toContain('source-message="source"');
 expect((await f.db.get('mirror')).content).toBe(target.content);
 expect(await f.db.get('child')).toMatchObject({transcript_revision:3,updated_at:999});
 expect(await f.run({...f.args,dry_run:false})).toEqual({dry_run:false,changed:0});
 expect((await f.db.get('child')).transcript_revision).toBe(3);
 expect(buildExistingMessagePatch(target,{role:'user',content:f.original.content})).toBeNull();
});
for(const [label,id,change] of [
 ['known human','target',{from_user_id:'owner'}],['stale content','target',{content:'Human replacement'}],
 ['wrong child','target',{conversation_id:'elsewhere'}],['wrong owner','child',{user_id:'someone'}],
 ['wrong parent','child',{parent_conversation_id:'elsewhere'}],['root session','child',{is_subagent:false}],
 ['unrelated source','source',{conversation_id:'elsewhere'}],['human source','source',{role:'user'}],['changed source','source',{tool_calls:[{id:'call',input:'agent-send.sh worker changed'}]}],
 ['source without helper','source',{tool_calls:[{input:'echo hello'}]}],['old source','source',{timestamp:-500000}],
] as const)test(`refuses ${label} before any repair`,async()=>{const f=fixture();await f.db.patch(id,change);const before=JSON.stringify(f.db._tables);await expect(f.run({...f.args,dry_run:false})).rejects.toThrow();expect(JSON.stringify(f.db._tables)).toBe(before);});
test('validates the complete batch before writing and rejects duplicate or oversized batches',async()=>{
 for(const entries of [ [fixture().args.entries[0],{...fixture().args.entries[0],message_id:'missing'}],Array(2).fill(fixture().args.entries[0]),Array(33).fill(fixture().args.entries[0]) ]){
  const f=fixture();await expect(f.run({...f.args,entries,dry_run:false})).rejects.toThrow();expect(await f.db.get('target')).toEqual(f.original);
 }
});
