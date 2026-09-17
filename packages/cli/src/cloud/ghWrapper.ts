/**
 * gh on the cloud host, authenticated by the same GitHub App installation
 * token git pushes with.
 *
 * gh reads GH_TOKEN from its environment, and `cast git-credential` already
 * mints a token for the repository in the current directory. So the host
 * keeps a small wrapper at `~/.local/bin/gh` (first on every agent's PATH,
 * agentSpawnPath.ts) that asks the helper for a token, exports it as GH_TOKEN
 * and execs the real gh. Nothing is written to disk: the token lives in the
 * environment of one gh process. When the helper has nothing (no repository
 * here, no installation, no network) gh runs exactly as it would without the
 * wrapper. An explicit GH_TOKEN or GITHUB_TOKEN always wins.
 *
 * The real gh lives wherever it was: anywhere else on PATH, or, when the host
 * tools step put it at `~/.local/bin/gh`, moved aside to REAL_GH_REL by the
 * install step so the wrapper can take its place. Both the wrapper and the
 * host tools check find it through `realGhFunction`, which skips any file
 * carrying the wrapper's marker.
 */

/** The line that identifies the wrapper; the real gh never contains it. */
export const GH_WRAPPER_MARKER = "# codecast gh wrapper";
/** Where the wrapper lives, relative to HOME. */
export const GH_WRAPPER_REL = ".local/bin/gh";
/** Where a real gh found at the wrapper's path is moved, relative to HOME. */
export const REAL_GH_REL = ".local/libexec/codecast/gh";

/**
 * Sets $CAST to the host's cast, or leaves it empty. POSIX sh; the host git
 * script and the wrapper share it.
 */
export const FIND_CAST_SH = `CAST=$(command -v cast 2>/dev/null || true)
if [ -z "$CAST" ]; then for c in "$HOME/.local/bin/cast" "$HOME/.bun/bin/cast" /usr/local/bin/cast; do [ -x "$c" ] && CAST="$c" && break; done; fi`;

/** A POSIX sh function `real_gh` that prints the real gh's path, or fails. */
export const realGhFunction = `real_gh() {
  if [ -x "$HOME/${REAL_GH_REL}" ]; then printf '%s\\n' "$HOME/${REAL_GH_REL}"; return 0; fi
  (IFS=:; for d in $PATH; do f="\${d:-.}/gh"; if [ -f "$f" ] && [ -x "$f" ] && ! head -c 512 "$f" 2>/dev/null | grep -qF '${GH_WRAPPER_MARKER}'; then printf '%s\\n' "$f"; exit 0; fi; done; exit 1)
}`;

/**
 * The wrapper. `-R`/`--repo` names the repository when it is given as
 * owner/name (or a github.com url of one); otherwise the helper reads the
 * origin of the current directory, which is how git itself invokes it.
 */
export function ghWrapperScript(): string {
  return `#!/bin/sh
${GH_WRAPPER_MARKER}
# Written by cast (cloud/ghWrapper.ts): GH_TOKEN from \`cast git-credential\`, then the real gh.
${realGhFunction}
real=$(real_gh) || { echo "gh: not installed on this host (cast hosts tools installs it)" >&2; exit 127; }
if [ -z "\${GH_TOKEN:-}\${GITHUB_TOKEN:-}" ] && { [ -z "\${GH_HOST:-}" ] || [ "\${GH_HOST}" = github.com ]; }; then
  case "\${1:-}" in
    ""|--version|version|completion) ;;
    *)
      repo=""; prev=""
      for a in "$@"; do
        case "$prev" in -R|--repo) repo=$a;; esac
        case "$a" in --repo=*) repo=\${a#--repo=};; -R?*) repo=\${a#-R};; esac
        prev=$a
      done
      repo=\${repo#https://}; repo=\${repo#github.com/}; repo=\${repo%/}; repo=\${repo%.git}
      case "$repo" in */*/*|*[!A-Za-z0-9._/-]*|/*|*/) repo="";; */*) ;; *) repo="";; esac
      ${FIND_CAST_SH.split("\n").join("\n      ")}
      if [ -n "$CAST" ]; then
        token=$( { printf 'protocol=https\\nhost=github.com\\n'; [ -z "$repo" ] || printf 'path=%s\\n' "$repo"; printf '\\n'; } | "$CAST" git-credential get 2>/dev/null | sed -n 's/^password=//p' | head -n 1)
        if [ -n "$token" ]; then GH_TOKEN=$token; export GH_TOKEN; fi
      fi
      ;;
  esac
fi
exec "$real" "$@"
`;
}

/**
 * The install step, for the host git script (bash, run from $HOME paths).
 * Idempotent: a real gh at the wrapper's path is moved aside first, and the
 * wrapper is replaced through a temp file so a running gh never reads half
 * of it.
 */
export function ghWrapperInstallSnippet(): string {
  return `gh_wrapper=""
GH_WRAPPER="$HOME/${GH_WRAPPER_REL}"
REAL_GH="$HOME/${REAL_GH_REL}"
mkdir -p "$(dirname "$GH_WRAPPER")" "$(dirname "$REAL_GH")"
if { [ -f "$GH_WRAPPER" ] || [ -L "$GH_WRAPPER" ]; } && ! head -c 512 "$GH_WRAPPER" 2>/dev/null | grep -qF '${GH_WRAPPER_MARKER}'; then
  mv -f "$GH_WRAPPER" "$REAL_GH" 2>/dev/null || gh_wrapper=blocked
fi
# A real gh that could not be moved aside is left where it is, never overwritten.
if [ "\${gh_wrapper:-}" != blocked ]; then
  gh_tmp="$GH_WRAPPER.cast-tmp.$$"
  cat > "$gh_tmp" <<'CAST_GH_WRAPPER'
${ghWrapperScript()}CAST_GH_WRAPPER
  chmod 755 "$gh_tmp" && mv -f "$gh_tmp" "$GH_WRAPPER" || rm -f "$gh_tmp"
fi`;
}
