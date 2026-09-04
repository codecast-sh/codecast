from html.parser import HTMLParser
from pathlib import Path
from collections import Counter
import re, json, sys

class Audit(HTMLParser):
    void = {'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[]; self.ids=[]; self.links=[]; self.errors=[]; self.h2=[]; self.heading=None; self.text=[]; self.figures=0; self.tables=0
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag in {'script','img','iframe'}: self.errors.append('Forbidden tag '+tag)
        if 'id' in a: self.ids.append(a['id'])
        if tag=='a' and a.get('href','').startswith('#'): self.links.append(a['href'][1:])
        if tag=='h2': self.heading=a.get('id'); self.h2.append(self.heading)
        if tag=='figure': self.figures+=1
        if tag=='table': self.tables+=1
        if tag not in self.void: self.stack.append(tag)
    def handle_endtag(self,tag):
        if tag in self.void:return
        if not self.stack or self.stack[-1]!=tag: self.errors.append('Unbalanced '+tag+' at '+str(self.getpos()))
        elif self.stack:self.stack.pop()
        if tag=='h2':self.heading=None
    def handle_startendtag(self,tag,attrs):
        self.handle_starttag(tag,attrs)
        if tag not in self.void:self.handle_endtag(tag)
    def handle_data(self,data):
        if not any(x in self.stack for x in ['style','head']):self.text.append(data)

p=Path(sys.argv[1] if len(sys.argv)>1 else Path(__file__).with_name('index.html'))
s=p.read_text(); a=Audit(); a.feed(s); a.close()
if a.stack:a.errors.append('Unclosed '+str(a.stack))
dups=[x for x,n in Counter(a.ids).items() if n>1]
missing=sorted(set(a.links)-set(a.ids))
if dups:a.errors.append('Duplicate IDs '+str(dups))
if missing:a.errors.append('Missing links '+str(missing))
if a.h2!=[f's{i}' for i in range(1,11)]:a.errors.append('Chapter headings '+str(a.h2))
if re.search(r'<!--\s*(FIGURE|MOCKUP):',s):a.errors.append('Unrendered figure')
text=' '.join(a.text)
if '\u2014' in text:a.errors.append('Em dash remains')
result={'file':str(p),'bytes':p.stat().st_size,'words':len(text.split()),'chapters':len(a.h2),'figures':a.figures,'tables':a.tables,'internal_links':len(a.links),'unique_ids':len(a.ids),'errors':a.errors}
print(json.dumps(result,indent=2));sys.exit(bool(a.errors))
