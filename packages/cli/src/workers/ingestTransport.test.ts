import {expect,test} from 'bun:test';
import {IngestAssembler,ingestTokenPages} from './ingestTransport.js';
import {validIngestJob,validIngestPage,INGEST_PAGE_BYTES,INGEST_PAGE_TOKENS} from './ingestTypes.js';
test('bounded structural pages preserve Unicode, nested objects and hostile property names',async()=>{
  const source=JSON.parse('{"__proto__":{"polluted":true},"constructor":"ordinary"}');
  source.large='a'.repeat(8191)+'🫠'+'b'.repeat(300_000);source.nested=[null,true,42,{unicode:'🧑‍💻'}];
  const assembler=new IngestAssembler();let count=0;
  for await(const tokens of ingestTokenPages(source)) {
    const page={cursor:'fixture',generation:'generation',sequence:count++,tokens,done:false};
    expect(validIngestPage(page)).toBe(true);expect(tokens.length).toBeLessThanOrEqual(INGEST_PAGE_TOKENS);expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(INGEST_PAGE_BYTES);assembler.push(tokens);
  }
  expect(count).toBeGreaterThan(1);expect(assembler.finish()).toEqual(source);expect(({} as any).polluted).toBeUndefined();
});
test('partial, duplicate, excessive and invalid structures never return a result',()=>{
  for(const tokens of [[['o'],['s'],['t','key'],['e']],[['s'],['t','unfinished']],[['o'],['z'],['o'],['z']],[['o'],['s'],['t','x'],['e'],['v',1],['s'],['t','x'],['e'],['v',2],['z']]]) {
    const a=new IngestAssembler();expect(()=>{a.push(tokens as any);a.finish();}).toThrow();
  }
  expect(()=>new IngestAssembler().push(Array.from({length:129},()=>['a']) as any)).toThrow('nesting');
  expect(validIngestPage({cursor:'c',generation:'g',sequence:0,tokens:[['t','a'.repeat(8193)]],done:false})).toBe(false);
  expect(validIngestPage({cursor:'c',generation:'g',sequence:0,tokens:Array.from({length:129},()=>['v',0]),done:false})).toBe(false);
  expect(validIngestJob({client:'claude',file:'/tmp/fixture',sessionId:'full-id',generation:'g',identity:{dev:0,ino:1,size:1,birthtimeMs:0,mtimeMs:0,ctimeMs:0},walIdentity:{size:1},offset:0})).toBe(false);
});
