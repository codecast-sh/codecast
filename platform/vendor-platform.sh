#!/usr/bin/env bash
# Mirror the shared @platform packages from this repo into an app's tree. The
# copy is GENERATED: never edit it by hand. It is what ships, because an app's
# deploys and release builds run from a fresh clone, so every @platform dep
# points inside the app's checkout (file:<path to the mirror>/packages/<name>)
# and never at ~/src/platform. Edit the canonical copy here, then refresh.
#
# This is the canonical script. Each app calls it through a thin wrapper at its
# own scripts/vendor-platform.sh that names the mirror and the consumers and
# adds whatever cache refresh its toolchain needs. A vendor run copies this
# script into the mirror beside the manifest, so a CI runner, which has no
# ~/src/platform, can still run --check-manifest, --list and --list-with-tests.
# A wrapper runs that copy for every mode; for vendor and --check the copy hands
# over to the canonical script of the repo it reads from.
#
#   vendor-platform.sh --mirror <dir> --consumers <glob> [--root <dir>] <mode> [names...]
#
#   vendor                  refresh the mirror (the default mode)
#   vendor <name...>        refresh only these packages (the rest stay as they are)
#   --check                 exit 1 if the mirror has drifted from the canonical repo
#   --check-manifest        exit 1 if the mirror is inconsistent (no canonical repo needed)
#   --write-manifest        regenerate the manifest from the mirror
#   --list                  print the mirrored package names
#   --list-with-tests       print the ones that have a test suite
#   --test                  install the mirror as one workspace and run every package's tests
#
#   --mirror <dir>     the mirror root: packages/, its workspace package.json,
#                      vendor-manifest.txt and a copy of this script
#   --consumers <glob> package.json files whose @platform deps define the set (repeatable)
#   --root <dir>       the app root that messages print paths relative to
#                      (default: the git toplevel holding the mirror)
#   --copies <glob>    after a vendor run, refresh in place every existing directory
#                      matching this glob whose name is a vendored package: the copies a
#                      package manager made of file: deps (bun's node_modules/.bun)
#   PLATFORM_DIR       the canonical repo to copy from (default ~/src/platform). Point it
#                      at a worktree of one platform commit, never a live tree another
#                      session is editing, so a vendor run never ships half a change.
#   PLATFORM_SRC       the packages directory directly (default $PLATFORM_DIR/packages)
#   VENDOR_CMD         how messages tell a person to rerun (default scripts/vendor-platform.sh)
#
# --check needs the canonical repo, so CI cannot run it. --check-manifest is the
# runner's half. It re-hashes the mirror against vendor-manifest.txt and re-reads
# the dep lines the mirror was generated from, so it catches a hand-edited
# mirror, a package adopted without a re-vendor, and a dep pointing outside the
# checkout. A mirror that is merely STALE against a newer canonical repo stays
# invisible to it, because nothing on a runner can see that repo (ct-49675).
#
# The mirror is a workspace of its own, as the canonical repo is: a vendor run
# writes package.json at the mirror root from the canonical root's, keeping its
# devDependencies (the test tooling every package's suite shares) and the
# workspace links to mirrored siblings. --test installs there once, so a
# package's @platform peer resolves to its mirrored sibling and never to npm,
# and each package's tests run with the tooling the canonical repo gives them.
# The app's own lockfile never sees any of it.
set -euo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
GIVEN=("$@")
MIRROR="" ROOT="" COPIES="" CONSUMER_GLOBS=() ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror) MIRROR="${2:?--mirror needs a directory}"; shift 2 ;;
    --consumers) CONSUMER_GLOBS+=("${2:?--consumers needs a glob}"); shift 2 ;;
    --root) ROOT="${2:?--root needs a directory}"; shift 2 ;;
    --copies) COPIES="${2:?--copies needs a glob}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done
[[ -n "$MIRROR" && ${#CONSUMER_GLOBS[@]} -gt 0 ]] || {
  echo "usage: vendor-platform.sh --mirror <dir> --consumers <glob> [--root <dir>] [mode] [names...]" >&2; exit 2; }
MODE="${ARGS[0]:-vendor}"

[[ -n "${PLATFORM_DIR:-}" || -z "${PLATFORM_SRC:-}" ]] || PLATFORM_DIR="$(dirname "$PLATFORM_SRC")"
PLATFORM_DIR="${PLATFORM_DIR:-$HOME/src/platform}"
SRC="${PLATFORM_SRC:-$PLATFORM_DIR/packages}"

# vendor and --check are the canonical repo's modes, so the canonical script
# runs them: a mirror's copy asked for either hands over to the script of the
# repo it is about to read, and every wrapper can simply run its copy. A
# PLATFORM_DIR at a commit from before this script has none, and the copy
# serves it. The other modes need no canonical repo and never look for one.
CANONICAL_SCRIPT="$PLATFORM_DIR/scripts/vendor-platform.sh"
if [[ "$MODE" == "vendor" || "$MODE" == "--check" ]] && [[ -f "$CANONICAL_SCRIPT" ]] \
  && ! cmp -s "$SELF" "$CANONICAL_SCRIPT"; then
  exec bash "$CANONICAL_SCRIPT" "${GIVEN[@]}"
fi
VENDOR_CMD="${VENDOR_CMD:-scripts/vendor-platform.sh}"
# Paths stay logical (pwd, never pwd -P) so the prefixes stripped for display
# agree with the paths the globs expand to.
absolute() { if [[ "$1" == /* ]]; then echo "$1"; else echo "$PWD/$1"; fi; }
MIRROR="$(absolute "$MIRROR")"
for i in "${!CONSUMER_GLOBS[@]}"; do CONSUMER_GLOBS[$i]="$(absolute "${CONSUMER_GLOBS[$i]}")"; done
default_root() {
  local d up; d=$(dirname "$MIRROR"); while [[ ! -d "$d" ]]; do d=$(dirname "$d"); done
  if up=$(git -C "$d" rev-parse --show-cdup 2>/dev/null); then (cd "$d/$up" && pwd); else echo "$d"; fi
}
ROOT="$(cd "${ROOT:-$(default_root)}" && pwd)"
PKGS="$MIRROR/packages"
MANIFEST="$MIRROR/vendor-manifest.txt"
WORKSPACE="$MIRROR/package.json"
show() { echo "${1#"$ROOT"/}"; }
PKGS_SHOW="$(show "$PKGS")"
MANIFEST_SHOW="$(show "$MANIFEST")"

# Each consumer with the path from its directory to the mirror's packages, the
# prefix its dep lines must carry. Paths are normalized as strings, so a mirror
# that does not exist yet still has a path. compgen lists a glob in directory
# order, so each glob's matches are sorted: messages name files in a fixed order.
CONSUMERS=$(for g in "${CONSUMER_GLOBS[@]}"; do compgen -G "$g" | sort || true; done | perl -MFile::Spec -e '
  sub norm { my @o; for (split m{/}, File::Spec->rel2abs($_[0])) {
    next if $_ eq "" || $_ eq "."; if ($_ eq "..") { pop @o } else { push @o, $_ } } "/" . join("/", @o) }
  my $pkgs = norm(shift);
  while (my $f = <STDIN>) { chomp $f; (my $d = norm($f)) =~ s{/[^/]*$}{}; print "$f\t", File::Spec->abs2rel($pkgs, $d), "\n" }
' "$PKGS")
[[ -n "$CONSUMERS" ]] || { echo "no consumer package.json matches: ${CONSUMER_GLOBS[*]}" >&2; exit 2; }

# The set is whatever the consumers depend on, so adopting a new package is one
# dep line and a rerun, never a second list to maintain.
dep_re() { printf '"@platform/[a-z-]*": "file:\\(\\./\\)\\{0,1\\}%s/[a-z-]*"' "$(sed 's/[][\.*^$]/\\&/g' <<<"$1")"; }
dep_lines() {
  local f rel
  while IFS=$'\t' read -r f rel; do grep -ho "$(dep_re "$rel")" "$f" || true; done <<<"$CONSUMERS"
}
list_packages() { dep_lines | sed 's#.*/\([a-z-]*\)"$#\1#' | sort -u; }

# `bun test` matches **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx} and exits 1
# when nothing matches, so the CI loop has to ask before it runs. Asking with a
# narrower pattern is worse than not asking: *.test.ts alone skips
# @platform/desktop, whose suite is entirely .test.js, and skips it silently.
has_tests() {
  [[ -n "$(find "$1" \( -name node_modules -o -name dist \) -prune -o \
    \( -name '*.test.*' -o -name '*.spec.*' -o -name '*_test_*' -o -name '*_spec_*' \) \
    -print -quit 2>/dev/null)" ]]
}

list_testable() {
  local p
  for p in $(list_packages); do
    if has_tests "$PKGS/$p"; then
      echo "$p"
    else
      echo "$PKGS_SHOW/$p has no tests" >&2
    fi
  done
}

RSYNC=(rsync -a --delete --exclude node_modules --exclude dist --exclude '*.tsbuildinfo' --exclude '*.probe.ts')
if command -v sha256sum >/dev/null 2>&1; then SHA=(sha256sum); else SHA=(shasum -a 256); fi

# One content hash per mirrored package: every file the vendor copy carries,
# path and bytes, in a stable order. The excludes match RSYNC's, plus the
# bun.lock a per-package `bun install` leaves behind (CI installs into the
# mirror to run its tests, and that must not read as drift).
tree_hash() {
  # -prune, not a path filter: a mirror that has been installed into carries a
  # node_modules far larger than the package, and walking it makes the check
  # slow enough to look hung.
  ( cd "$1" && find . \( -name node_modules -o -name dist \) -prune -o -type f \
      ! -name '*.tsbuildinfo' ! -name '*.probe.ts' \
      ! -name 'bun.lock' ! -name '.DS_Store' \
      -exec "${SHA[@]}" {} + | LC_ALL=C sort -k2 ) | "${SHA[@]}" | cut -d' ' -f1
}

# The manifest's name for the mirror's workspace package.json: no package can
# be called this, so it never collides with one.
WORKSPACE_ENTRY="(workspace)"
file_hash() { "${SHA[@]}" < "$1" | cut -d' ' -f1; }

# The mirror's workspace root, from the canonical root package.json: the
# mirrored packages as members, the root's devDependencies, and of its
# @platform links only those to packages this mirror holds.
workspace_json() {
  perl -MJSON::PP -e '
    my ($src, @mirrored) = @ARGV;
    my %have = map { ("\@platform/$_" => 1) } @mirrored;
    open my $fh, "<", $src or die "cannot read $src\n";
    my $root = decode_json(do { local $/; <$fh> });
    my %dev = %{ $root->{devDependencies} // {} };
    delete $dev{$_} for grep { m{^\@platform/} && !$have{$_} } keys %dev;
    my %out = (
      name => "platform-mirror",
      private => JSON::PP::true,
      description => "Generated by scripts/vendor-platform.sh from the platform repo root: the mirror installs and tests as one workspace. Do not edit by hand.",
      workspaces => ["packages/*"],
      devDependencies => \%dev,
    );
    $out{packageManager} = $root->{packageManager} if $root->{packageManager};
    print JSON::PP->new->canonical->pretty->indent_length(2)->encode(\%out);
  ' "$PLATFORM_DIR/package.json" $(list_packages)
}
write_workspace() {
  workspace_json > "$WORKSPACE.tmp" && mv -f "$WORKSPACE.tmp" "$WORKSPACE"
  echo "wrote $(show "$WORKSPACE")"
}

write_manifest() {
  {
    echo "# Generated by scripts/vendor-platform.sh. Do not edit by hand."
    echo "# <sha256 of the mirrored files>  <package>"
    for p in $(list_packages); do
      printf '%s  %s\n' "$(tree_hash "$PKGS/$p")" "$p"
    done
    if [[ -f "$WORKSPACE" ]]; then printf '%s  %s\n' "$(file_hash "$WORKSPACE")" "$WORKSPACE_ENTRY"; fi
  } > "$MANIFEST"
  echo "wrote $MANIFEST_SHOW"
}

# Everything a runner can prove about the mirror without the canonical repo.
check_manifest() {
  local drift=0 p expected actual f rel

  # 1. Every @platform dep points inside the checkout, at its own name. A dep
  # resolving outside breaks the fresh-clone builds this mirror exists for, and
  # list_packages would not even see it.
  # Only string-valued entries: an @platform key under peerDependenciesMeta
  # holds an object and declares no path at all.
  local stray
  stray=$(while IFS=$'\t' read -r f rel; do
    grep -Hn '"@platform/[a-z-]*": *"' "$f" | grep -v "$(dep_re "$rel")" || true
  done <<<"$CONSUMERS")
  if [[ -n "$stray" ]]; then
    echo "@platform deps that do not point at file:$(cut -f2 <<<"$CONSUMERS" | sort -u | paste -sd'|' - | sed 's/|/ or /g')/<name>:"
    echo "$stray" | sed "s#^$ROOT/#  #"
    drift=1
  fi
  local mismatched
  mismatched=$(dep_lines \
    | sed 's#"@platform/\([a-z-]*\)": "file:.*/\([a-z-]*\)"#\1 \2#' \
    | awk -v dir="$PKGS_SHOW" '$1 != $2 { print "  " $1 " resolves to " dir "/" $2 }' | sort -u)
  if [[ -n "$mismatched" ]]; then
    echo "@platform deps whose name and directory disagree:"; echo "$mismatched"; drift=1
  fi

  local packages; packages=$(list_packages)

  # 2. Every declared package is actually mirrored, under its own name.
  for p in $packages; do
    if [[ ! -f "$PKGS/$p/package.json" ]]; then
      echo "$PKGS_SHOW/$p is declared as a dep but not mirrored: run $VENDOR_CMD"
      drift=1
      continue
    fi
    local declared
    declared=$(grep -o '"name": *"[^"]*"' "$PKGS/$p/package.json" | head -1 | sed 's#.*"name": *"\(.*\)"#\1#')
    if [[ "$declared" != "@platform/$p" ]]; then
      echo "$PKGS_SHOW/$p declares itself as $declared"
      drift=1
    fi
  done

  # 3. No mirrored package that nothing depends on. A leftover directory ships
  # to every fresh clone and no vendor run ever refreshes it.
  if [[ -d "$PKGS" ]]; then
    for dir in "$PKGS"/*/; do
      [[ -d "$dir" ]] || continue
      p=$(basename "$dir")
      if ! grep -qx "$p" <<<"$packages"; then
        echo "$PKGS_SHOW/$p is mirrored but no workspace package depends on it"
        drift=1
      fi
    done
  fi

  # 4. The mirror's bytes are the ones the last vendor run produced.
  if [[ ! -f "$MANIFEST" ]]; then
    echo "$MANIFEST_SHOW is missing: run $VENDOR_CMD --write-manifest"
    return 1
  fi
  local listed; listed=$(awk -v w="$WORKSPACE_ENTRY" '!/^#/ && NF && $2 != w { print $2 }' "$MANIFEST" | sort -u)
  if [[ "$listed" != "$packages" ]]; then
    echo "$MANIFEST_SHOW covers a different package set than the workspace deps:"
    diff <(echo "$listed") <(echo "$packages") | sed 's/^/  /' || true
    drift=1
  fi
  for p in $packages; do
    [[ -d "$PKGS/$p" ]] || continue
    expected=$(awk -v p="$p" '!/^#/ && $2 == p { print $1 }' "$MANIFEST")
    actual=$(tree_hash "$PKGS/$p")
    if [[ -n "$expected" && "$expected" != "$actual" ]]; then
      echo "$PKGS_SHOW/$p does not match the manifest: it was edited by hand, or vendored without updating $MANIFEST_SHOW"
      drift=1
    fi
  done

  # 5. The workspace root is the one the last vendor run wrote. A mirror
  # vendored before the mirror had one carries neither, and passes.
  expected=$(awk -v w="$WORKSPACE_ENTRY" '!/^#/ && $2 == w { print $1 }' "$MANIFEST")
  if [[ -n "$expected" && ! -f "$WORKSPACE" ]]; then
    echo "$(show "$WORKSPACE") is missing: run $VENDOR_CMD"
    drift=1
  elif [[ -f "$WORKSPACE" && "$expected" != "$(file_hash "$WORKSPACE")" ]]; then
    echo "$(show "$WORKSPACE") does not match the manifest: it was edited by hand, or written without updating $MANIFEST_SHOW"
    drift=1
  fi

  if [[ $drift -eq 0 ]]; then echo "vendored platform packages are internally consistent"; fi
  return $drift
}

# Every mirrored package's own tests, installed the way the canonical repo
# installs them: once, as one workspace at the mirror root. Each package runs
# even after another fails, so one run names every red suite, and a run that
# found no suite at all is a failure, never a quiet pass.
run_tests() {
  [[ -f "$WORKSPACE" ]] || { echo "$(show "$WORKSPACE") is missing: run $VENDOR_CMD"; return 1; }
  (cd "$MIRROR" && bun install) || { echo "bun install failed in $(show "$MIRROR")"; return 1; }
  local p ran=0 failed=()
  for p in $(list_testable); do
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::group::$PKGS_SHOW/$p"; else echo "== $PKGS_SHOW/$p"; fi
    (cd "$PKGS/$p" && bun test) || failed+=("$p")
    if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::endgroup::"; fi
    ran=$((ran + 1))
  done
  if [[ $ran -eq 0 ]]; then echo "no mirrored package has tests: nothing ran"; return 1; fi
  if [[ ${#failed[@]} -gt 0 ]]; then echo "failed in $ran packages run: ${failed[*]}"; return 1; fi
  echo "tests passed in $ran mirrored packages"
}

case "$MODE" in
  --list) list_packages; exit 0 ;;
  --list-with-tests) list_testable; exit 0 ;;
  --write-manifest) write_manifest; exit 0 ;;
  --check-manifest) if check_manifest; then exit 0; else exit 1; fi ;;
  --test) if run_tests; then exit 0; else exit 1; fi ;;
  --check|vendor) ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac

PACKAGES=$(list_packages)
# A vendor run may name packages: adopting one then never carries another
# package's unfinished canonical work into this tree.
if [[ "$MODE" == "vendor" && ${#ARGS[@]} -gt 1 ]]; then
  for p in "${ARGS[@]:1}"; do
    grep -qx "$p" <<<"$PACKAGES" || { echo "no workspace package depends on @platform/$p" >&2; exit 2; }
  done
  PACKAGES="${ARGS[*]:1}"
fi

# A file that differs only in mode is drift only when its executable bit
# differs, the one mode bit git records. bun installs a package's bin target as
# a hardlink to the mirror file and marks it 777, so every install rewrites the
# mirror's mode (update-prompt's src/cli.ts) without changing anything git sees.
mode_only_same_exec() {
  [[ "$1" =~ ^\.f\.*p\.*$ ]] || return 1
  [[ -x "$SRC/$2/$3" ]] && a=1 || a=0
  [[ -x "$PKGS/$2/$3" ]] && b=1 || b=0
  [[ $a == "$b" ]]
}

# The copy of this script that rides in the mirror, so runners can check it.
MIRROR_SCRIPT="$MIRROR/vendor-platform.sh"

if [[ "$MODE" == "--check" ]]; then
  drift=0
  for p in $PACKAGES; do
    out=$("${RSYNC[@]}" -n -i "$SRC/$p/" "$PKGS/$p/" | grep -v '^\.d' \
      | while read -r flags path; do mode_only_same_exec "$flags" "$p" "$path" || echo "$flags $path"; done || true)
    if [[ -n "$out" ]]; then echo "$PKGS_SHOW/$p differs from $SRC/$p:"; echo "$out" | sed 's/^/  /'; drift=1; fi
  done
  if ! cmp -s <(workspace_json) "$WORKSPACE" 2>/dev/null; then
    echo "$(show "$WORKSPACE") differs from what $PLATFORM_DIR/package.json makes of it"; drift=1
  fi
  if [[ -f "$CANONICAL_SCRIPT" && -f "$MIRROR_SCRIPT" ]] && ! cmp -s "$CANONICAL_SCRIPT" "$MIRROR_SCRIPT"; then
    echo "$(show "$MIRROR_SCRIPT") differs from $CANONICAL_SCRIPT"; drift=1
  fi
  [[ $drift -eq 0 ]] && echo "vendored platform packages match $SRC"
  exit $drift
fi

for p in $PACKAGES; do
  mkdir -p "$PKGS/$p"
  "${RSYNC[@]}" "$SRC/$p/" "$PKGS/$p/"
done
echo "vendored $(echo "$PACKAGES" | wc -w | tr -d ' ') packages from $SRC: $(echo $PACKAGES)"
write_workspace
# The manifest is what CI re-checks without the canonical repo, so it is only
# ever true right after a real vendor run.
write_manifest

# A package manager keeps serving its copy of a file: dep after the mirror
# changes. Refresh each existing copy in place from the mirror: rsync swaps file
# by file, so a module is never missing while running processes keep importing
# it. Deleting the copies first left a window of minutes under load in which
# every import of the package failed with "Cannot find module".
if [[ -n "$COPIES" ]]; then
  while IFS= read -r copy; do
    [[ -d "$copy" ]] || continue
    name=$(basename "$copy")
    grep -qx "$name" <<<"$(echo $PACKAGES | tr ' ' '\n')" || continue
    if [[ -d "$PKGS/$name" ]]; then "${RSYNC[@]}" "$PKGS/$name/" "$copy/"; fi
  done < <(compgen -G "$COPIES" || true)
fi

# Replace, never rewrite in place: bash reads a script while it runs it, and the
# copy being replaced may be the one running now.
if ! cmp -s "$SELF" "$MIRROR_SCRIPT"; then
  tmp=$(mktemp "$MIRROR/.vendor-platform.XXXXXX")
  cp "$SELF" "$tmp" && chmod 755 "$tmp" && mv -f "$tmp" "$MIRROR_SCRIPT"
  echo "copied this script to $(show "$MIRROR_SCRIPT")"
fi
