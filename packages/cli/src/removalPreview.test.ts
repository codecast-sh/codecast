import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commandSegments, describeRemovals } from "./removalPreview";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "removal-preview-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const touch = (rel: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), "x"); };
for (let i = 0; i < 4; i++) touch(`lab/page/a/fs/${i}.mp3`);
touch("lab/page/a/fs/.hidden");
touch("lab/page/a/fs/keep.txt");
touch("lab/tree/x/y/z.txt");
touch("lab/tree/top.txt");

describe("describeRemovals", () => {
  test("follows the cd and counts what the glob matches (the sound session's command)", () => {
    const command = [
      `cd ${root}/lab && cat > scripts/proc.sh <<'EOF'`,
      "#!/bin/bash",
      'rm -f "$tmp"',
      "EOF",
      "rm -f page/a/fs/*.mp3; for f in raw/*.mp3; do scripts/proc.sh $f page/a/fs/$(basename $f); done",
    ].join("\n");
    expect(describeRemovals(command, "/somewhere/else")).toEqual([
      { target: `${root}/lab/page/a/fs/*.mp3`, files: 4, dirs: 0 },
    ]);
  });

  test("a glob skips dotfiles, as the shell does", () => {
    expect(describeRemovals("rm page/a/fs/*", `${root}/lab`)).toEqual([{ target: `${root}/lab/page/a/fs/*`, files: 5, dirs: 0 }]);
  });

  test("a recursive removal counts everything under the folder", () => {
    expect(describeRemovals(`rm -rf ${root}/lab/tree`, "/")).toEqual([{ target: `${root}/lab/tree`, files: 2, dirs: 3 }]);
    expect(describeRemovals(`rm -f ${root}/lab/tree`, "/")).toEqual([{ target: `${root}/lab/tree`, files: 0, dirs: 1 }]);
  });

  test("names why a target cannot be counted", () => {
    expect(describeRemovals('rm -rf "$OUT"/*', root)).toEqual([{ target: "$OUT/*", note: "set by the shell when it runs" }]);
    expect(describeRemovals("cd $(mktemp -d) && rm -f x/*", root)).toEqual([{ target: "x/*", note: "after a cd that cannot be resolved" }]);
    expect(describeRemovals(`rm ${root}/*/fs/a`, "/")[0].note).toBe("a pattern in a parent folder");
  });

  test("a missing target counts nothing, and commands without rm give nothing", () => {
    expect(describeRemovals("rm -f gone.txt", root)).toEqual([{ target: `${root}/gone.txt`, files: 0, dirs: 0 }]);
    expect(describeRemovals("ls -la && echo rm", root)).toEqual([]);
  });
});

describe("commandSegments", () => {
  test("splits on operators outside quotes and drops heredoc bodies", () => {
    expect(commandSegments(`cd "/a b" && echo 'x; y' | wc\ncat <<EOF\nrm -rf /\nEOF\nrm z`)).toEqual([
      ["cd", "/a b"], ["echo", "x; y"], ["wc"], ["cat"], ["rm", "z"],
    ]);
  });
});
