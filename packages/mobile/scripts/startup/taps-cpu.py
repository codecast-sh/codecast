# taps-cpu.py <run dir>: process CPU (ms) spent in each tap's window (until the next tap), beside its probe line
import sys,re
d=sys.argv[1]
taps=[float(l) for l in open(d+'/taps.txt')] if __import__('os').path.exists(d+'/taps.txt') else []
rows=[l.split() for l in open(d+'/cpu.log')][1:]
samp=[(float(r[0]),float(r[1])+float(r[2])) for r in rows if len(r)==4]
probe={int(m.group(1)):m.group(0) for m in re.finditer(r"\[tap\] #(\d+) .*",open(d+'/log').read())}
def cpu_at(t):
    b=[c for ts,c in samp if ts<=t]; return b[-1] if b else None
for i,t in enumerate(taps):
    e=taps[i+1] if i+1<len(taps) else t+3
    a,b=cpu_at(t),cpu_at(e)
    c=int((b-a)*1000) if a is not None and b is not None else -1
    p=probe.get(i+1,'')
    m=re.search(r"lag=(\d+) first=(\d+) settle=(\d+) gap=(\d+) (\S+) -> (\S+)",p)
    f=m.groups() if m else ('','','','','','')
    route=lambda r: re.sub(r'/session/\w+','/s',r)
    print(f"{i+1:>2} cpu={c:>5}ms  first={f[1]:>5} settle={f[2]:>5}  {route(f[4])} -> {route(f[5])}")
