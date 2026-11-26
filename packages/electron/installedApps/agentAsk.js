// cast.app.agent.ask (docs/architecture/installed-apps.md, "Permission tiers",
// `agent`): an installed app asks the person's agent a question. It runs as
// them through their own cast CLI, `cast exec`, so it counts toward their
// usage and leaves no inbox card. The engine has already checked the grant.
//
// createAskAgent({cli?, home?, spawn?, timeoutMs?, maxOutput?})
//   -> askAgent(slug, prompt, {name}) -> Promise<{answer}>
//
// The CLI is found the way daemonSetup.js finds it (computerPermissions'
// resolveCli: $CODECAST_CLI, ~/.local/bin, ~/.codecast/bin, Homebrew). The
// prompt goes on stdin (`cast exec -`), so a prompt that starts with "--" is
// never read as a flag, and its first line names the app that asked.
//
// It runs `cast exec --agent claude --answer-only`: claude with no built-in
// tools and no MCP servers, in dontAsk, ignoring the person's configured
// agent args, default params and claude settings. Any page may hold the agent
// grant and steer the prompt, so what the agent can do must not follow the
// person's own setup: `--permission-mode default` alone left claude on the
// settings' defaultMode (auto, or bypassPermissions), with tools that run
// commands and read files from the home folder. A cast too old to know
// --answer-only refuses the flag, which fails closed. Widening that would be
// its own, separate grant.
const os = require("node:os");
const { spawn: nodeSpawn } = require("node:child_process");
const { resolveCli } = require("../computerPermissions");
const { AppError } = require("./protocol");

const TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT = 256 * 1024;
const TAIL_CHARS = 400;
/** The cast exec arguments: an answer from the prompt alone, prompt on stdin. */
const EXEC_ARGS = ["exec", "--agent", "claude", "--answer-only", "-"];

/** The prompt as the agent reads it: one line naming the app, then the page's words. */
function agentPrompt(slug, prompt, name) {
  const label = name && name !== slug ? `"${name}" (page ${slug})` : `page ${slug}`;
  return `This question comes from the installed Codecast app ${label}.\n\n${prompt}`;
}

function createAskAgent({ cli, home = os.homedir(), spawn = nodeSpawn, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT } = {}) {
  const findCli = () => cli || resolveCli({ home });

  return function askAgent(slug, prompt, { name } = {}) {
    const bin = findCli();
    // resolveCli answers the bare name when it found no binary.
    if (!bin || bin === "cast") {
      return Promise.reject(new AppError("failed", "asking your agent needs the cast CLI, which is not installed on this computer"));
    }
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(bin, EXEC_ARGS, { cwd: home, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (err) {
        return reject(new AppError("failed", `could not start the cast CLI: ${err.message}`));
      }
      let out = "";
      let err = "";
      let truncated = false;
      let timedOut = false;
      child.stdout.on("data", (d) => {
        if (out.length >= maxOutput) return void (truncated = true);
        out += d;
        if (out.length > maxOutput) {
          out = out.slice(0, maxOutput);
          truncated = true;
        }
      });
      child.stderr.on("data", (d) => (err = (err + d).slice(-TAIL_CHARS)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new AppError("failed", `could not start the cast CLI: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new AppError("failed", `your agent did not answer within ${Math.round(timeoutMs / 60_000) || 1} minutes`));
        if (code !== 0) return reject(new AppError("failed", `your agent stopped (exit ${code})${err.trim() ? `: ${err.trim()}` : ""}`));
        resolve({ answer: out.trim(), ...(truncated ? { truncated: true } : {}) });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(agentPrompt(slug, prompt, name));
    });
  };
}

module.exports = { createAskAgent, agentPrompt, EXEC_ARGS, TIMEOUT_MS, MAX_OUTPUT };
