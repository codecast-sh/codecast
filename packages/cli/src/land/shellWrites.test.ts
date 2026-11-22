// What a shell command writes (shellWrites.ts), and only that: attribution credits a dirty file to the session whose
// command wrote it, so a path a command reads or runs must never count. Each case is a shape seen in a real
// transcript; the first ones are the commands that told the wrong session about a file.
import { describe, expect, test } from "bun:test";
import { parseCommands, pythonWrites, shellWritePaths } from "./shellWrites";

const W = "/work/app";
const writes = (cmd: string, cwd = W) => shellWritePaths(cmd, cwd, "/home/me").map((w) => `${w.dir}:${w.path}`);

describe("what a command only reads or runs is never a write", () => {
  test("running a program with its output sent to /tmp credits the log, not the program", () => {
    expect(writes("bun packages/cli/src/index.ts ship checkout --dry-run > /tmp/x.log")).toEqual([`${W}:/tmp/x.log`]);
    expect(writes("bun ~/src/codecast/.conductor/pipeline-data/packages/cli/src/index.ts flow pipeline 2>&1 | tail -5")).toEqual([]);
  });

  test("reading tools name files they do not write", () => {
    expect(writes("cat packages/a.ts | grep foo > /tmp/hits; sed -n 1,20p packages/b.ts; head -5 c.md")).toEqual([`${W}:/tmp/hits`]);
    expect(writes("grep -rn x src 2>/dev/null; wc -l src/*.ts &>/dev/null")).toEqual([]);
    expect(writes("python3 scripts/report.py --out json && node tools/check.js")).toEqual([]);
  });

  test("the command that told jx74gwv about main's index.ts writes only its worktree's pipeline.ts", () => {
    const cmd = "cd ~/src/codecast/.conductor/pipeline-data/packages/cli && python3 - <<'EOF'\np='src/pipeline.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF\ncd ~/src/codecast/.conductor/pipeline-data && bun packages/cli/src/index.ts flow pipeline 2>&1";
    expect(shellWritePaths(cmd, "/home/me/src/codecast", "/home/me")).toEqual([{ path: "src/pipeline.ts", dir: "/home/me/src/codecast/.conductor/pipeline-data/packages/cli" }]);
  });
});

describe("each kind of write", () => {
  test("redirects: >, >>, n>, &>, a heredoc into a file; never a descriptor dup or /dev/null", () => {
    expect(writes("echo hi > a.txt; echo more >> b.txt; cmd 2> err.log; cmd &> all.log; cmd >/dev/null 2>&1")).toEqual([`${W}:a.txt`, `${W}:b.txt`, `${W}:err.log`, `${W}:all.log`]);
    expect(writes("cat > notes.md <<'EOF'\nline > not-a-file\nEOF")).toEqual([`${W}:notes.md`]);
    expect(writes("echo x>c.txt")).toEqual([`${W}:c.txt`]);
  });

  test("tee, sed -i (GNU and BSD), perl -i", () => {
    expect(writes("ls | tee -a list.txt out.txt")).toEqual([`${W}:list.txt`, `${W}:out.txt`]);
    expect(writes("sed -i '' 's/a/b/' x.ts y.ts")).toEqual([`${W}:x.ts`, `${W}:y.ts`]);
    expect(writes("sed -i 's/a/b/' x.ts; sed -i.bak -e 's/a/b/' z.ts; sed 's/a/b/' read.ts")).toEqual([`${W}:x.ts`, `${W}:z.ts`]);
    expect(writes("perl -pi -e 's/a/b/' p.ts; perl -ne 'print' read.ts")).toEqual([`${W}:p.ts`]);
  });

  test("mv, cp, install, ln land at their destination (into a directory under the same name); mv's source is gone", () => {
    expect(writes("mv old.ts new.ts")).toEqual([`${W}:new.ts`, `${W}:old.ts`]);
    expect(writes("cp a.ts b.ts dest/")).toEqual([`${W}:dest/a.ts`, `${W}:dest/b.ts`]);
    expect(writes("cp -r src/a.ts lib/a.ts; install -m 755 bin/x /usr/local/bin/x; ln -sf target link")).toEqual([`${W}:lib/a.ts`, `${W}:/usr/local/bin/x`, `${W}:link`]);
  });

  test("rm, unlink, touch, truncate, git rm/mv/restore and checkout --", () => {
    expect(writes("rm -f a.ts b.ts; unlink c.ts; touch d.ts; truncate -s 0 e.log")).toEqual([`${W}:a.ts`, `${W}:b.ts`, `${W}:c.ts`, `${W}:d.ts`, `${W}:e.log`]);
    expect(writes("git rm -q x.ts && git mv y.ts z.ts && git restore w.ts && git checkout -- v.ts u.ts && git checkout main")).toEqual([`${W}:x.ts`, `${W}:z.ts`, `${W}:y.ts`, `${W}:w.ts`, `${W}:v.ts`, `${W}:u.ts`]);
    expect(writes("git -C /other/repo checkout -- f.ts; git diff -- g.ts; git status")).toEqual(["/other/repo:f.ts"]);
  });

  test("python and node code a command runs: open(p, 'w'), write_text, writeFileSync; never a read", () => {
    expect(pythonWrites("p='src/a.ts'\ns=open(p).read()\nopen(p,'w').write(s)\nwith open(\"b.json\", \"a\") as f: f.write(x)\nopen('c.txt').read()\nPath('d.md').write_text(t)\nq = Path(\"e.md\")\nq.write_text(t)")).toEqual(["src/a.ts", "b.json", "d.md", "e.md"]);
    expect(writes(`python3 -c "open('x.txt','w').write('1')"`)).toEqual([`${W}:x.txt`]);
    // A name reassigned between writes: each write is the file it named then (one heredoc edits two files).
    expect(pythonWrites("p='components/a.tsx'\ns=open(p).read()\nopen(p,'w').write(s)\n\np='../cli/src/index.ts'\ns=open(p).read()\nopen(p,'w').write(s)")).toEqual(["components/a.tsx", "../cli/src/index.ts"]);
    expect(writes(`node -e "require('fs').writeFileSync('y.json', '{}')"`)).toEqual([`${W}:y.json`]);
    expect(writes("bun - <<'EOF'\nawait Bun.write('z.txt', 'x')\nconst a = require('fs').readFileSync('r.txt')\nEOF")).toEqual([`${W}:z.txt`]);
  });

  test("bash -c and a heredoc to sh are read as commands", () => {
    expect(writes(`bash -c "cd sub && echo x > f.txt"`)).toEqual([`${W}/sub:f.txt`]);
  });
});

describe("where each path is read from", () => {
  test("from the cd in effect when the command names it; a subshell's cd ends with it", () => {
    expect(writes("cd pkg && echo x > a.txt; cd .. ; echo y > b.txt")).toEqual([`${W}/pkg:a.txt`, `${W}:b.txt`]);
    expect(writes("(cd sub && touch in.txt) && touch out.txt")).toEqual([`${W}/sub:in.txt`, `${W}:out.txt`]);
    expect(writes("cd ~/proj && rm x.ts")).toEqual(["/home/me/proj:x.ts"]);
  });

  test("a path the shell cannot know (a variable, a command substitution) is not guessed", () => {
    expect(writes('echo x > "$OUT"; rm $(cat list.txt); cp a.ts "$DEST/a.ts"')).toEqual([]);
  });

  test("quotes and escapes come off the words", () => {
    expect(writes(`echo x > "with space.txt"; rm 'it'\\''s.txt'`)).toEqual([`${W}:with space.txt`, `${W}:it's.txt`]);
    expect(parseCommands("a 'b c' \"d\" e\\ f", W)[0].words).toEqual(["a", "b c", "d", "e f"]);
  });
});
