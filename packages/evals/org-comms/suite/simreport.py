import os
HOME_DIR = os.path.join(os.environ.get("CODECAST_EVALS_HOME") or os.path.expanduser("~/.local/share/codecast/evals"), "org-comms")
import json,glob,sys,collections
tag=sys.argv[1]
by=collections.defaultdict(list)
for f in glob.glob(os.path.join(HOME_DIR,'sim',tag)+'/*/*/world.json'):
    w=json.load(open(f)); r=w['result']; log=w['log']
    ww=sum(1 for x in log for t in x['sent'] if x['agent']!='L' and t!='L')
    wl=sum(1 for x in log for t in x['sent'] if x['agent']!='L' and t=='L')
    lw=sum(1 for x in log for t in x['sent'] if x['agent']=='L')
    noise=r['noise_spread']
    DISC={'F1':1,'F2':2,'F4':2,'F5':3,'F7':1,'F8':2,'F10':3}; lat=[(v or 7)-DISC[k.split('->')[0]] for k,v in r['latency'].items()]
    by[r['policy']].append(dict(needed=r['needed'],sends=r['sends'],ww=ww,wl=wl,lw=lw,ontime=r['delivered_on_time'],noise=noise,reads=sum(len(x['reads']) for x in log),delay=sum(lat)/len(lat),missed=r['missed']))
print(f"{'policy':7}{'worlds':>7}{'sends':>7}{'w->w':>6}{'w->L':>6}{'L->w':>6}{'on-time':>10}{'noise msgs':>11}{'reads':>7}{'rounds':>7}  missed")
for p,R in sorted(by.items()):
    n=len(R); a=lambda k: sum(r[k] for r in R)/n
    print(f"{p:7}{n:7}{a('sends'):7.1f}{a('ww'):6.1f}{a('wl'):6.1f}{a('lw'):6.1f}{a('ontime'):6.2f}/{R[0]['needed']:<3}{a('noise'):11.1f}{a('reads'):7.1f}{a('delay'):7.2f}  {[m for r in R for m in r['missed']]}")
