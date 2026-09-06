import { expect, test } from 'bun:test';
import { create } from './tasks';
import { hashToken } from './apiTokens';
import { makeFakeDb } from './testDb';

async function fixture() {
  const tables: Record<string, any[]> = {
    users: [{_id:'users_a',name:'A'},{_id:'users_b',name:'B'}],
    api_tokens: [
      {_id:'api_tokens_a',user_id:'users_a',token_hash:await hashToken('token-a')},
      {_id:'api_tokens_b',user_id:'users_b',token_hash:await hashToken('token-b')},
    ],
    conversations: [{_id:'conversations_a',session_id:'native-full-a',user_id:'users_a',status:'active'}],
    tasks: [], counters: [], entity_subscriptions: [], task_history: [],
  };
  const effects: unknown[] = [];
  const ctx = {db:makeFakeDb(tables),scheduler:{runAfter:async()=>null},runMutation:async(...args:unknown[])=>{effects.push(args);return null;}};
  const submit = (over:Record<string,unknown> = {}) => (create as any)._handler(ctx,{api_token:'token-a',title:'Same task',source:'plan_mode',conversation_id:'native-full-a',...over});
  return {tables,effects,submit};
}

test('API task occurrence key replays one committed task and its side effects once',async()=>{
  const f=await fixture();
  const first=await f.submit({client_key:'transcript-task:occurrence-one'});
  const effects=f.effects.length;
  const second=await f.submit({client_key:'transcript-task:occurrence-one'});
  expect(second).toEqual(first);
  expect(f.tables.tasks).toHaveLength(1);
  expect(f.effects.length).toBe(effects);
  expect(f.tables.tasks[0]).toMatchObject({user_id:'users_a',workspace:'user:users_a',client_key:'transcript-task:occurrence-one',created_from_conversation:'conversations_a'});
  const distinct=await f.submit({client_key:'transcript-task:occurrence-two'});
  expect(distinct.id).not.toBe(first.id);
  expect(f.tables.tasks).toHaveLength(2);
});

test('keyed retry after lost committed response reuses the actual backend result',async()=>{
  const f=await fixture();
  let lost=true;
  const send=async()=>{
    const result=await f.submit({client_key:'transcript-task:lost'});
    if(lost){lost=false;throw new Error('lost response');}
    return result;
  };
  await expect(send()).rejects.toThrow('lost response');
  const result=await send();
  expect(result.id).toBe(f.tables.tasks[0]._id);
  expect(f.tables.tasks).toHaveLength(1);
});

test('keys are owner scoped and unauthenticated replay is refused',async()=>{
  const f=await fixture();
  const first=await f.submit({client_key:'shared-key'});
  const second=await f.submit({api_token:'token-b',client_key:'shared-key'});
  expect(second.id).not.toBe(first.id);
  expect(f.tables.tasks.map(t=>t.workspace)).toEqual(['user:users_a','user:users_b']);
  await expect(f.submit({api_token:'invalid',client_key:'shared-key'})).rejects.toThrow('Unauthorized');
  await expect(f.submit({status:'invalid',client_key:'shared-key'})).rejects.toThrow();
  expect(f.tables.tasks).toHaveLength(2);
});

test('no-key calls preserve distinct identical tasks and existing workspace validation',async()=>{
  const f=await fixture();
  const first=await f.submit(),second=await f.submit();
  expect(second.id).not.toBe(first.id);
  expect(f.tables.tasks).toHaveLength(2);
  expect(f.tables.tasks.every(t=>t.client_key===undefined)).toBe(true);
  await expect(f.submit({project_id:'projects_missing'})).rejects.toThrow();
  expect(f.tables.tasks).toHaveLength(2);
});

test('same-user replay requires current workspace membership and matching context',async()=>{
  const f=await fixture();
  f.tables.teams=[{_id:'teams_a',name:'Team'}];
  f.tables.team_memberships=[{_id:'team_memberships_a',team_id:'teams_a',user_id:'users_a',role:'member'}];
  f.tables.conversations.push({_id:'conversations_team',session_id:'native-team',user_id:'users_a',team_id:'teams_a',team_visibility:'team',is_private:false});
  const args={client_key:'team-key',conversation_id:'native-team'};
  const first=await f.submit(args);
  expect(f.tables.tasks[0].workspace).toBe('team:teams_a');
  await expect(f.submit({...args,conversation_id:'native-full-a'})).rejects.toThrow(/workspace|context/);
  f.tables.team_memberships.length=0;
  await expect(f.submit(args)).rejects.toThrow();
  expect(f.tables.tasks).toHaveLength(1);
  expect(f.tables.tasks[0]._id).toBe(first.id);
});

test('existing key cannot bypass conversation, project, plan, or parent validation',async()=>{
  const f=await fixture();
  const args={client_key:'context-key'};
  await f.submit(args);
  f.tables.conversations.push({_id:'conversations_other',session_id:'native-other',user_id:'users_a',status:'active'});
  await expect(f.submit({...args,conversation_id:'native-other'})).rejects.toThrow('different context');
  await expect(f.submit({...args,project_id:'projects_missing'})).rejects.toThrow();
  await expect(f.submit({...args,plan_id:'pl-missing'})).rejects.toThrow();
  await expect(f.submit({...args,parent_id:'ct-missing'})).rejects.toThrow();
  expect(f.tables.tasks).toHaveLength(1);
});
