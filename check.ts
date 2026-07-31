import { monoStyle, Mono } from './fonts';
const cases: Array<[string, any, string]> = [
  ['no weight',            {},                                              Mono.regular],
  ['normal keyword',       { fontWeight: 'normal' },                        Mono.regular],
  ['400',                  { fontWeight: '400' },                           Mono.regular],
  ['500 medium',           { fontWeight: '500' },                           Mono.medium],
  ['600 semibold',         { fontWeight: '600' },                           Mono.semiBold],
  ['bold keyword',         { fontWeight: 'bold' },                          Mono.bold],
  ['700',                  { fontWeight: '700' },                           Mono.bold],
  ['900',                  { fontWeight: '900' },                           Mono.bold],
  ['italic',               { fontStyle: 'italic' },                         Mono.italic],
  ['legacy SpaceMono+600', { fontFamily: 'SpaceMono', fontWeight: '600' },   Mono.semiBold],
  ['array merge',          [{ fontWeight: '600' }, { color: 'red' }],        Mono.semiBold],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const out: any = monoStyle(input);
  const ok = out.fontFamily === want && !('fontWeight' in out) && !('fontStyle' in out);
  if (!ok) { bad++; console.log(`FAIL ${name}: got ${JSON.stringify(out)}, want family=${want} with no fontWeight/fontStyle`); }
  else console.log(`ok   ${name.padEnd(22)} -> ${out.fontFamily}`);
}
const ext: any = monoStyle({ fontFamily: 'Georgia', fontWeight: '600' } as any);
if (ext.fontFamily !== 'Georgia' || ext.fontWeight !== '600') { bad++; console.log('FAIL non-mono family not preserved:', JSON.stringify(ext)); }
else console.log('ok   non-mono family passthrough keeps its fontWeight');
console.log(bad === 0 ? '\nALL MONO CHECKS PASS' : `\n${bad} FAILURES`);
