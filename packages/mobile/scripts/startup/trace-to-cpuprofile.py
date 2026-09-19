# trace-to-cpuprofile.py <trace.json> <out.cpuprofile>: merge Profile/ProfileChunk trace events into one CDP cpuprofile
import json,sys
ev=json.load(open(sys.argv[1]))
nodes={}; samples=[]; deltas=[]; start=None; parent_of={}
for e in ev:
    if e.get('name')=='Profile':
        start=e['args']['data'].get('startTime',e.get('ts'))
    if e.get('name')=='ProfileChunk':
        d=e['args']['data']; cp=d.get('cpuProfile',{})
        for n in cp.get('nodes',[]):
            nid=n['id']
            if nid not in nodes: nodes[nid]={'id':nid,'callFrame':n['callFrame'],'children':[]}
            p=n.get('parent')
            if p is not None and nid not in parent_of:
                parent_of[nid]=p
        samples.extend(cp.get('samples',[])); deltas.extend(d.get('timeDeltas',[]))
for nid,p in parent_of.items():
    if p in nodes and nid not in nodes[p]['children']: nodes[p]['children'].append(nid)
total_us=sum(deltas)
prof={'nodes':list(nodes.values()),'samples':samples,'timeDeltas':deltas,'startTime':start or 0,'endTime':(start or 0)+total_us}
json.dump(prof,open(sys.argv[2],'w'))
print(f"nodes {len(nodes)} samples {len(samples)} span {total_us/1e6:.1f}s")
