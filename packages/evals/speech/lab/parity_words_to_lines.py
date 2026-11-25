"""Dump the wordsToLines parity fixture from words_to_lines (shared/contracts/speakers.test.ts reads it).

  python3 -I parity_words_to_lines.py lab.py > ../../../shared/contracts/__fixtures__/wordsToLines.parity.json
"""
import ast, json, sys
src = open(sys.argv[1]).read()
fns = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in ("words_to_lines", "words_to_lines_activity")]
ns = {}
exec(compile(ast.Module(body=fns, type_ignores=[]), "lab.py", "exec"), ns)
w2l = ns["words_to_lines"]
w2la = ns["words_to_lines_activity"]
cases = []
# 1: two speakers trading, overlap, a long pause inside one speaker, unassigned words, near-edge words
words = [["hello",0.0,0.4],["there",0.45,0.8],["how",0.9,1.1],["are",1.15,1.3],["you",1.35,1.6],
         ["fine",1.7,2.0],["thanks",2.05,2.5],["and",4.0,4.2],["you",4.25,4.5],
         ["um",9.0,9.2],["right",9.6,9.9],["ok",10.5,10.8],["so",12.4,12.6],["yes",12.7,13.0],
         ["far",60.0,60.3],["away",60.35,60.6],["edge",20.3,20.5],["tail",21.0,21.2]]
words.sort(key=lambda w: w[1])
turns = [{"speaker":"spk:0","start":0.0,"end":1.2},{"speaker":"spk:1","start":1.1,"end":2.6},
         {"speaker":"spk:0","start":3.9,"end":4.6},{"speaker":"spk:1","start":9.5,"end":11.0},
         {"speaker":"spk:2","start":12.3,"end":13.1},{"speaker":"spk:0","start":19.0,"end":20.0},
         {"speaker":"spk:2","start":21.0,"end":21.0}]
cases.append({"words":words,"turns":turns,"gap":1.2})
# 2: same words, smaller gap, turns given out of order
cases.append({"words":words,"turns":list(reversed(turns)),"gap":0.3})
# 3: no turns at all
cases.append({"words":words[:5],"turns":[],"gap":1.2})
for c in cases:
    c["lines"] = w2l(c["words"], c["turns"], gap=c["gap"])
# Activity rule: three voices at 50 ms hops over 14 s, a quiet stretch (below
# the floor: previous word's label), an overlap where the louder voice wins,
# a tie (first label keeps it), and a word past the end of the frames.
import math
hop = 0.05
n = int(14 / hop)
def lane(spans, level=0.9):
    return [round(level if any(a <= i * hop < b for a, b in spans) else 0.02 + 0.01 * math.sin(i), 4) for i in range(n)]
labels = {"spk:0": lane([(0, 1.15), (3.9, 4.6), (12.3, 12.65)]), "spk:1": lane([(1.1, 2.6), (9.5, 11.0)], 0.7), "spk:2": lane([(12.3, 13.1)], 0.9)}
act_words = words[:14] + [["late", 14.5, 14.8]]
activity = {"hop": hop, "labels": labels}
for gap, floor in ((1.2, 0.15), (0.3, 0.5)):
    cases.append({"words": act_words, "turns": [], "gap": gap, "floor": floor,
                  "activity": {"hop_s": hop, "labels": labels},
                  "lines": w2la(act_words, activity, gap=gap, floor=floor)})
json.dump({"generated_by":"packages/evals/speech/lab/parity_words_to_lines.py","cases":cases}, sys.stdout, indent=1)
