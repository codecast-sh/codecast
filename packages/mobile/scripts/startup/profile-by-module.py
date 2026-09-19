# profile-by-module.py <cpuprofile> <dev bundle> [n]: self and inclusive time by function, with the source module of each frame
import json,sys,re,bisect,collections
p=json.load(open(sys.argv[1])); n=int(sys.argv[3]) if len(sys.argv)>3 else 30
starts=[];names=[]
cur_start=None
with open(sys.argv[2],encoding='utf8',errors='ignore') as f:
    for i,line in enumerate(f):
        if line.startswith('__d('): cur_start=i
        m=re.search(r'\},(\d+),\[[^\]]*\],"([^"]+)"\);\s*$',line)
        if m and cur_start is not None:
            starts.append(cur_start); names.append(m.group(2)); cur_start=None
def module(line):
    k=bisect.bisect_right(starts,line)-1
    if k<0: return '?'
    s=names[k]; s=re.sub(r'.*node_modules/\.bun/[^/]+/node_modules/','nm:',s); return s[-70:]
nodes={x['id']:x for x in p['nodes']}; parent={}
for x in p['nodes']:
    for c in x.get('children',[]): parent[c]=x['id']
samples=p['samples']; S=len(samples); selfc=collections.Counter(samples)
def key(nid):
    f=nodes[nid]['callFrame']; fn=f.get('functionName') or '(anon)'
    return (fn, module(f.get('lineNumber',0)) if f.get('url') else '')
busy=S-sum(c for nid,c in selfc.items() if key(nid)[0] in ('(idle)',))
print(f"{S} samples, JS thread busy {100*busy/S:.1f}% of {(sum(p['timeDeltas'])/1e6):.0f}s")
selfk=collections.Counter(); total=collections.Counter(); modself=collections.Counter()
for nid,c in selfc.items():
    k=key(nid); selfk[k]+=c; modself[k[1]]+=c
    seen=set(); cur=nid
    while cur is not None:
        kk=key(cur)
        if kk not in seen: total[kk]+=c; seen.add(kk)
        cur=parent.get(cur)
print("\nSELF by module (share of busy time)")
for m,c in modself.most_common(16):
    if m!='' or True: print(f"{100*c/busy:5.1f}%  {m or '(native/builtin)'}")
print("\nINCLUSIVE by function (share of busy time), skipping generic plumbing")
skip=re.compile(r'^(\(root\)|\(idle\)|\(anon\)|tryCallOne|tryCallTwo|doResolve|_next|asyncGeneratorStep|generatorPrototypeNext|functionPrototypeApply|functionPrototypeCall|hermesBuiltinApply|Promise|handleResolved|finale|resolve|flushedQueue|__guard|__callReactNativeMicrotasks|step|next|anonymous|apply|callFunctionReturnFlushedQueue|__callFunction)$')
shown=0
for k,c in total.most_common(400):
    if skip.match(k[0]) or k[0].startswith('?anon'): continue
    print(f"{100*c/busy:5.1f}%  {k[0]}  [{k[1]}]"); shown+=1
    if shown>=n: break
