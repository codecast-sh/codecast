import { expect, spyOn, test } from 'bun:test';
import { parseCursorChatData } from './cursorChatParser.js';
import type { ParsedMessage, TranscriptEmission } from './parser.js';
import { ingestReceiptSignature } from './workers/ingestReceipt.js';

test('Cursor database emission preserves filtered bubble ordinals, native facts and public output', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const data = {tabs:[{tabId:'ignored'},{tabId:'first',bubbles:[
      {type:'ignored',rawText:'ignored'},
      {type:'user',initText:'generated user'},
      {type:'ai',rawText:'identical'},
      {type:'user',initText:''},
      {type:'ai',rawText:'identical'},
      {type:'user',initText:'native user',contextCacheTimestamp:1234},
      {type:'ai',rawText:'generated ai',contextCacheTimestamp:1234},
    ]},{tabId:'invalid',bubbles:{}},{tabId:'second',bubbles:[
      {type:'user',initText:'zero native',contextCacheTimestamp:0},
      {type:'ai',id:'healthy-ai-id',rawText:'healthy ai'},
      {type:'user',id:'healthy-user-id',initText:'healthy user',contextCacheTimestamp:5678},
    ]}]};
    const observed: Array<{message:ParsedMessage;source:TranscriptEmission}> = [];
    const first = parseCursorChatData(JSON.stringify(data),true,(message,source)=>observed.push({message,source}));
    expect(first).toEqual(parseCursorChatData(JSON.stringify(data)));
    expect(observed.every((row,i)=>row.message===first[i])).toBe(true);
    expect(observed.map(row=>row.source.occurrence)).toEqual([1,2,4,5,6,7,8,9]);
    expect(observed.map(row=>row.source.receiptTimestamp)).toEqual([0,0,0,1234,0,0,0,5678]);
    expect(observed[0].source.timestampPresent).toBe(false);
    expect(observed[4].source.nativeTimestamp).toBe(1234);
    expect(observed[5].source.timestampPresent).toBe(true);
    expect(observed[5].source.nativeTimestamp).toBe(0);
    expect(first.slice(-2).map(message=>message.uuid)).toEqual(['healthy-ai-id','healthy-user-id']);
    clock.mockReturnValue(2_000_000_001_000);
    const reread: typeof observed = [];
    parseCursorChatData(JSON.stringify(data),true,(message,source)=>reread.push({message,source}));
    expect(first[0].timestamp).not.toBe(reread[0].message.timestamp);
    expect(observed.map(row=>ingestReceiptSignature(row.message,row.source))).toEqual(reread.map(row=>ingestReceiptSignature(row.message,row.source)));
    const ai = observed[4];
    expect(ingestReceiptSignature(ai.message,{...ai.source,nativeTimestamp:1235})).not.toBe(ingestReceiptSignature(ai.message,ai.source));
    expect(ingestReceiptSignature({...ai.message,content:'changed'},ai.source)).not.toBe(ingestReceiptSignature(ai.message,ai.source));
    expect(parseCursorChatData('{')).toEqual([]);
    expect(()=>parseCursorChatData('{',true)).toThrow();
  } finally { clock.mockRestore(); }
});
