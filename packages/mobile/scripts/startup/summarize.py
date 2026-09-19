# summarize.py <run-dir>...: boot marks and process CPU at fixed times after launch
import sys,re
for d in sys.argv[1:]:
    rows=[l.split() for l in open(d+'/cpu.log')]
    t0=float(rows[0][0]); samp=[(float(r[0])-t0,float(r[1])+float(r[2]),int(r[3])//1024) for r in rows[1:] if len(r)==4]
    marks=re.findall(r"\[boot\] (\d+)ms ([\w-]+)([^\n]*)",open(d+'/marks.log').read())
    def at(t):
        best=[s for s in samp if s[0]<=t]; return best[-1] if best else None
    first=samp[0] if samp else None
    print(d.split('/')[-1])
    print("  marks:", "; ".join(f"{n} {ms}ms" for ms,n,_ in marks if n!='after-polyfills'))
    print("  cache paint:", next((x.strip() for ms,n,x in marks if n=='paintCache'),''))
    for t in (10,20,30,45,60):
        s=at(t)
        if s and first: print(f"  t={t:>2}s  cpu {s[1]:6.1f}s  rss {s[2]:5d} MB")
    print(f"  peak rss {max(s[2] for s in samp)} MB, last sample t={samp[-1][0]:.0f}s cpu {samp[-1][1]:.1f}s")
