# profile-window.py <cpuprofile> <dev bundle> [from_ms to_ms] [n]: app functions by inclusive time inside a window (a tap's at= to at=+first, say), plus a busy timeline
import json,sys,re,bisect,collections
p=json.load(open(sys.argv[1])); B=sys.argv[2]
lo=float(sys.argv[3]) if len(sys.argv)>3 else None; hi=float(sys.argv[4]) if len(sys.argv)>4 else None
N=int(sys.argv[5]) if len(sys.argv)>5 else 40
starts=[];names=[];cur=None
for i,line in enumerate(open(B,encoding='utf8',errors='ignore')):
    if line.startswith('__d('): cur=i
    m=re.search(r'\},(\d+),\[[^\]]*\],"([^"]+)"\);\s*$',line)
    if m and cur is not None: starts.append(cur); names.append(m.group(2)); cur=None
def module(l):
    k=bisect.bisect_right(starts,l)-1
    return '?' if k<0 else re.sub(r'.*node_modules/(\.bun/[^/]+/node_modules/)?','nm:',names[k])
nodes={x['id']:x for x in p['nodes']}; parent={}
for x in p['nodes']:
    for c in x.get('children',[]): parent[c]=x['id']
t=p['startTime']; times=[]
for d in p['timeDeltas']: t+=d; times.append(t/1000)
memo={}
def key(n):
    if n in memo: return memo[n]
    f=nodes[n]['callFrame']; r=(f.get('functionName') or '(anon)', module(f.get('lineNumber',0)) if f.get('url') else ''); memo[n]=r; return r
tot=collections.Counter(); busy=0; S=0; tl=collections.Counter(); tlb=collections.Counter()
for s,tm in zip(p['samples'],times):
    if lo is not None and not (lo<=tm<=hi): continue
    S+=1; b=int((tm-(lo or times[0]))//250); tlb[b]+=1
    if key(s)[0]=='(idle)': continue
    busy+=1; tl[b]+=1; seen=set(); c=s
    while c is not None:
        k=key(c)
        if k not in seen and not k[1].startswith('nm:') and k[1] and k[1]!='?': tot[k]+=1; seen.add(k)
        c=parent.get(c)
print(f"window {lo}..{hi}: {S} samples, busy {100*busy/max(S,1):.0f}%  (profile {times[0]:.0f}..{times[-1]:.0f})")
print("busy per 250ms:", ' '.join(f"{100*tl[b]//max(tlb[b],1)}" for b in sorted(tlb)))
for k,c in tot.most_common(N): print(f"{100*c/max(busy,1):5.1f}%  {k[0]}  [{k[1][-60:]}]")
