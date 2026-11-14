import { appPool } from '@codecast/web/lib/line/flowPool';
import { flowDiagram, routeTail } from '@codecast/web/lib/line/flowDiagram';
const f = appPool([]).find(x=>x.slug==='change')!; const m = flowDiagram(f);
const p=(s:any,d:number)=>{console.log(' '.repeat(d*2)+s.label,s.kind,s.id, s.inner.length, s.side.map((r:any)=>`${r.outcome} ${routeTail(r)} [${r.tone}]`).join(' | ')); if(s.inner.length>1) s.inner.forEach((i:any)=>p(i,d+1));};
m.steps.forEach(s=>p(s,0)); console.log('end',m.end,m.endId,m.hub);
