#!/bin/bash
# Prints the git remote whose main a Convex push must not be behind.
#
# A Convex push ships a whole-tree snapshot, so a tree behind the deployment's
# source of truth deletes newer functions (the 2026-07-15 outage). dev.sh, the
# gated pusher and deploy.sh all check freshness against <remote>/main. In a
# clone of a fork, `origin` is the fork, which can be hundreds of commits
# behind codecast-sh/codecast while the tree still looks "fresh" against it.
#
# Order: $CONVEX_FRESHNESS_REMOTE when set (a self-hosted deployment whose
# source of truth is your own repo), else the remote that fetches
# codecast-sh/codecast, else origin.
cd "$(dirname "$0")" || exit 1
if [ -n "${CONVEX_FRESHNESS_REMOTE:-}" ]; then
    echo "$CONVEX_FRESHNESS_REMOTE"
    exit 0
fi
git remote -v 2>/dev/null | awk '$3 == "(fetch)" && $2 ~ /[:\/]codecast-sh\/codecast(\.git)?$/ { print $1; found = 1; exit } END { if (!found) print "origin" }'
