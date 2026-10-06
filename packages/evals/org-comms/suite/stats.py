import os
HOME_DIR = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
import json,sys,random,collections
def mw_p(a,b,iters=20000,seed=0):
    # one-sided: P(b > a) by permutation of the rank-sum (Mann-Whitney U)
    def U(x,y): return sum((1 if xi>yi else 0.5 if xi==yi else 0) for xi in x for yi in y)
    obs=U(b,a); pool=a+b; n=len(b); r=random.Random(seed); ge=0
    for _ in range(iters):
        r.shuffle(pool); 
        if U(pool[:n],pool[n:])>=obs: ge+=1
    return ge/iters
A,B=(sys.argv[1].split(',') if ',' in sys.argv[1] else ('C','G'))
for rnd in [a for a in sys.argv[1:] if ',' not in a]:
    R=[r for r in json.load(open(os.path.join(HOME_DIR,'suite-runs',rnd,'results.json'))) if r['score'] is not None]
    by=collections.defaultdict(list)
    for r in R: by[(r['variant'],r['scenario'])].append(r['score'])
    scen=sorted({s for _,s in by})
    print(f'== {rnd}')
    for s in scen:
        c,g=by[(A,s)],by[(B,s)]
        if c and g: print(f'  {s:16} C {sum(c)/len(c):.2f} (n{len(c)})  G {sum(g)/len(g):.2f} (n{len(g)})')
    C=[x for s in scen for x in by[(A,s)]]; G=[x for s in scen for x in by[(B,s)]]
    if C and G: print(f'  POOLED C {sum(C)/len(C):.3f}  G {sum(G)/len(G):.3f}  one-sided p(G>C) = {mw_p(C,G):.4f}')
