// Run: node --test packages/electron/installedApps/agentAsk.test.js
//
// agent.ask through a fake cast binary: a shell script that records its
// arguments, working directory and stdin, and answers the way the test asks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAskAgent, agentPrompt } = require("./agentAsk");

const posix = process.platform !== "win32";

function fakeCast(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ask-"));
  const bin = path.join(dir, "cast");
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/args"\npwd > "${dir}/cwd"\ncat > "${dir}/stdin"\n${body}\n`, { mode: 0o755 });
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  return { dir, bin, read, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("the prompt's first line names the app that asked", () => {
  assert.equal(agentPrompt("k3j2h4ab", "hi", "Vitals"), 'This question comes from the installed Codecast app "Vitals" (page k3j2h4ab).\n\nhi');
  assert.equal(agentPrompt("k3j2h4ab", "hi"), "This question comes from the installed Codecast app page k3j2h4ab.\n\nhi");
});

test("asks through cast exec with the prompt on stdin, from the home directory", { skip: !posix }, async () => {
  const fake = fakeCast("echo '  the answer  '");
  const home = fs.realpathSync(fake.dir);
  try {
    const ask = createAskAgent({ cli: fake.bin, home });
    assert.deepEqual(await ask("k3j2h4ab", "--version?", { name: "Vitals" }), { answer: "the answer" });
    assert.equal(fake.read("args").trim(), "exec --agent claude --answer-only -", "no tools, whatever the person's settings allow");
    assert.equal(fake.read("cwd").trim(), home);
    assert.equal(fake.read("stdin"), agentPrompt("k3j2h4ab", "--version?", "Vitals"));
  } finally {
    fake.done();
  }
});

test("a failing agent refuses with failed and what it said", { skip: !posix }, async () => {
  const fake = fakeCast("echo 'usage limit reached' >&2; exit 3");
  try {
    const ask = createAskAgent({ cli: fake.bin, home: fake.dir });
    await assert.rejects(ask("k3j2h4ab", "hi"), (e) => e.code === "failed" && /exit 3/.test(e.message) && /usage limit reached/.test(e.message));
  } finally {
    fake.done();
  }
});

test("a slow agent is stopped at the timeout", { skip: !posix }, async () => {
  const fake = fakeCast("exec sleep 30");
  try {
    const ask = createAskAgent({ cli: fake.bin, home: fake.dir, timeoutMs: 200 });
    await assert.rejects(ask("k3j2h4ab", "hi"), (e) => e.code === "failed" && /did not answer/.test(e.message));
  } finally {
    fake.done();
  }
});

test("a long answer is capped", { skip: !posix }, async () => {
  const fake = fakeCast("head -c 5000 /dev/zero | tr '\\0' a");
  try {
    const ask = createAskAgent({ cli: fake.bin, home: fake.dir, maxOutput: 1000 });
    const reply = await ask("k3j2h4ab", "hi");
    assert.equal(reply.answer.length, 1000);
    assert.equal(reply.truncated, true);
  } finally {
    fake.done();
  }
});

test("without a cast CLI it refuses with a clear failed", async () => {
  // resolveCli answers the bare name when it finds no binary.
  const ask = createAskAgent({ cli: "cast" });
  await assert.rejects(ask("k3j2h4ab", "hi"), (e) => e.code === "failed" && /cast CLI/.test(e.message));
});
