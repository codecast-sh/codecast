# module-eval.py <cpuprofile> <dev bundle> [n]: module evaluation time at boot, each sample charged to the innermost module factory on its stack
import json,sys,re,bisect,collections
p=json.load(open(sys.argv[1])); n=int(sys.argv[3]) if len(sys.argv)>3 else 40
starts=[];names=[];cur=None
for i,line in enumerate(open(sys.argv[2],encoding='utf8',errors='ignore')):
    if line.startswith('__d('): cur=i
    m=re.search(r'\},(\d+),\[[^\]]*\],"([^"]+)"\);\s*$',line)
    if m and cur is not None: starts.append(cur); names.append(m.group(2)); cur=None
def module(l):
    k=bisect.bisect_right(starts,l)-1
    return '?' if k<0 else re.sub(r'.*node_modules/(\.bun/[^/]+/node_modules/)?','nm:',names[k])
nodes={x['id']:x for x in p['nodes']}; parent={}
for x in p['nodes']:
    for c in x.get('children',[]): parent[c]=x['id']
fn=lambda i: nodes[i]['callFrame'].get('functionName','')
own=collections.Counter(); incl=collections.Counter(); total=0; S=len(p['samples'])
for s in p['samples']:
    chain=[]; c=s
    while c is not None: chain.append(c); c=parent.get(c)
    facts=[c for c in chain if parent.get(c) is not None and fn(parent[c])=='loadModuleImplementation']
    if not facts: continue
    total+=1
    own[module(nodes[facts[0]]['callFrame'].get('lineNumber',0))]+=1
    for m in set(module(nodes[f]['callFrame'].get('lineNumber',0)) for f in facts): incl[m]+=1
ms=lambda c: c*sum(p['timeDeltas'])/1000/S
print(f"module evaluation: {ms(total):.0f} ms of {ms(S):.0f} ms traced")
print("OWN (excluding nested requires)")
for m,c in own.most_common(n): print(f"{ms(c):7.0f} ms  {m[-90:]}")
print("INCLUSIVE")
for m,c in incl.most_common(25): print(f"{ms(c):7.0f} ms  {m[-90:]}")
