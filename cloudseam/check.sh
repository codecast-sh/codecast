#!/usr/bin/env bash
# Run INSIDE a cloud session: what crossed from the laptop, and does it work.
cd "$(git rev-parse --show-toplevel)" || exit 1
. cloudseam/expected.env
sha() { sha256sum "$1" 2>/dev/null | cut -c1-16; }
r() { printf '%-4s %-28s %s\n' "$1" "$2" "$3"; }
chk() { if eval "$2" >/dev/null 2>&1; then r PASS "$1" "$3"; else r FAIL "$1" "$3"; fi; }
echo "== host $(hostname) user $(whoami) cwd $PWD"
echo "== checkout"
chk "cloud env var"        '[ "$CODECAST_CLOUD" = 1 ]' "CODECAST_CLOUD=${CODECAST_CLOUD:-unset}"
chk "branch"               '[ "$(git rev-parse --abbrev-ref HEAD)" = "$EXP_BRANCH" ]' "$(git rev-parse --abbrev-ref HEAD) want $EXP_BRANCH"
chk "HEAD incl unpushed"   '[ "$(git rev-parse HEAD)" = "$EXP_HEAD" ]' "$(git rev-parse --short HEAD)"
chk "committed file"       '[ -f cloudseam/committed.txt ]' ""
chk "uncommitted edit"     '[ "$(sha README.md)" = "$EXP_README" ]' ""
chk "staged edit"          '[ "$(sha CHANGELOG.md)" = "$EXP_CHANGELOG" ]' "staged on host: $(git diff --cached --name-only | tr '\n' ' ')"
chk "deleted file"         '[ ! -e docs/exec.md ]' ""
chk "untracked file"       'grep -q "untracked content" cloudseam/untracked.txt' ""
chk "name with space"      '[ -f "cloudseam/with space.txt" ]' ""
chk "binary file"          '[ "$(sha cloudseam/bin.dat)" = "$EXP_BIN" ]' ""
chk "exec bit"             '[ -x cloudseam/run.sh ]' ""
chk "symlink"              '[ -L cloudseam/link ] && [ "$(readlink cloudseam/link)" = untracked.txt ]' ""
chk ".env.local (manifest)" '[ "$(sha .env.local)" = "$EXP_ENVLOCAL" ]' ""
chk "convex .env.local"    '[ "$(sha packages/convex/.env.local)" = "$EXP_CONVEX_ENVLOCAL" ]' ""
chk "ignored non-manifest stays" '[ ! -e cloudseam/local.log ]' "(expected to stay on laptop)"
echo "== home: agent config"
chk "~/.claude/CLAUDE.md"  '[ "$(sha ~/.claude/CLAUDE.md)" = "$EXP_CLAUDE_MD" ] || grep -q "Write Plainly" ~/.claude/CLAUDE.md' ""
chk "skills"               '[ "$(ls ~/.claude/skills | wc -l)" -ge "$EXP_SKILLS" ]' "$(ls ~/.claude/skills | wc -l) of $EXP_SKILLS"
chk "project memory"       'ls ~/.claude/projects/*/memory/MEMORY.md' "$(ls -d ~/.claude/projects/*/memory 2>/dev/null | tr '\n' ' ')"
chk "user MCP servers"     'python3 -c "import json,os;d=json.load(open(os.path.expanduser(\"~/.claude.json\")));assert d.get(\"mcpServers\")"' ""
echo "== home: shell"
chk "laptop alias in shell" 'bash -lic "alias $EXP_ALIAS_SAMPLE" 2>/dev/null | grep -q "="' "alias $EXP_ALIAS_SAMPLE"
chk "rc-exported key"      'bash -lic "[ -n \"\$OPENAI_API_KEY\" ]" 2>/dev/null' "OPENAI_API_KEY from .bash_profile"
chk "rc in agent shell"    '[ -n "$OPENAI_API_KEY" ]' "the agent's own Bash tool env"
echo "== logins"
chk "gh"                   'gh api user -q .login' "$(gh api user -q .login 2>&1 | tail -1)"
for t in convex wrangler vercel aws fly railway gcloud supabase stripe cf; do
  if command -v $t >/dev/null 2>&1; then r INFO "$t cli" "installed"; else r INFO "$t cli" "not installed"; fi
done
chk "convex login file"    '[ -s ~/.convex/config.json ]' ""
chk "cloudflare login"     '[ -s ~/.config/cloudflare/config/default.json ] || [ -s ~/.wrangler/config/default.toml ]' ""
chk "aws credentials"      '[ -s ~/.aws/credentials ]' ""
chk "aws works"            'aws sts get-caller-identity' ""
chk "vercel login"         '[ -s ~/.local/share/com.vercel.cli/auth.json ]' ""
chk "gcloud login"         '[ -s ~/.config/gcloud/credentials.db ]' ""
chk "npm token"            'grep -q _auth ~/.npmrc' ""
echo "== git"
chk "ssh to github"        'ssh -o BatchMode=yes -T git@github.com 2>&1 | grep -q "successfully authenticated"' ""
chk "push access"          'git push --dry-run origin HEAD:refs/heads/cloudseam-probe' ""
echo "== network"
for u in https://api.github.com https://registry.npmjs.org https://pypi.org/simple/ https://api.anthropic.com https://convex.dev; do
  chk "reach ${u#https://}" "curl -sS -o /dev/null -m 10 -w '%{http_code}' $u | grep -qE '^[2-4]'" ""
done
echo "== done"
