import os
HOME_DIR = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
import json,sys,glob,os
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from scenarios import SCENARIOS
G={s['id']:s['grade'] for s in SCENARIOS}
for rnd in sys.argv[1:]:
    out=[]
    for f in glob.glob(os.path.join(HOME_DIR,'suite-runs',rnd)+'/*/*/*/graded.json'):
        r=json.load(open(f)); r['score']=G[r['scenario']](r['parsed']) if r['parsed'] else None; json.dump(r,open(f,'w')); out.append(r)
    json.dump(out,open(os.path.join(HOME_DIR,'suite-runs',rnd,'results.json'),'w'))
    print(rnd,len(out))
