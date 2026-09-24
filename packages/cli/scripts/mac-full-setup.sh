#!/usr/bin/env bash
# Full one-time setup of a Scaleway Mac for cast remote.
# Run from the local machine; everything happens over SSH.
# Prereqs: host registered in ~/.codecast/scaleway/hosts.json + SSH key.
set -uo pipefail
source "$(dirname "$0")/../.env.cloud-test"
IP=${MAC_IP:-51.159.120.28}; MUSER=${MAC_USER:-m1}
KEY=~/.codecast/scaleway/d7_id_ed25519
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 $MUSER@$IP"

echo "[1/7] install Claude Code"
$SSH 'command -v claude >/dev/null 2>&1 || (curl -fsSL https://claude.ai/install.sh | bash 2>&1 | tail -2)'
echo "[2/7] install bun"
$SSH 'command -v bun >/dev/null 2>&1 || (curl -fsSL https://bun.sh/install | bash 2>&1 | tail -2)'
echo "[3/7] install tmux (from source, no sudo)"
$SSH 'test -x $HOME/.local/bin/tmux && echo "tmux already built" || {
  P=$HOME/.local; mkdir -p $P/src
  cd $P/src && curl -fsSL -o libevent.tar.gz https://github.com/libevent/libevent/releases/download/release-2.1.12-stable/libevent-2.1.12-stable.tar.gz
  tar xzf libevent.tar.gz && cd libevent-2.1.12-stable && ./configure --prefix=$P --disable-shared --disable-openssl >/dev/null 2>&1 && make -j4 >/dev/null 2>&1 && make install >/dev/null 2>&1
  cd $P/src && curl -fsSL -o tmux.tar.gz https://github.com/tmux/tmux/releases/download/3.5a/tmux-3.5a.tar.gz
  tar xzf tmux.tar.gz && cd tmux-3.5a && ./configure --prefix=$P --disable-utf8proc CFLAGS="-I$P/include" LDFLAGS="-L$P/lib" >/dev/null 2>&1 && make -j4 >/dev/null 2>&1 && make install >/dev/null 2>&1
  echo "tmux: $($P/bin/tmux -V)"
}'
echo "[4/7] transfer codecast source (git archive)"
cd /Users/ashot/src/codecast && git archive --format=tar HEAD | gzip > /tmp/cc-src.tgz
$SSH "rm -rf /Users/$MUSER/work/codecast && mkdir -p /Users/$MUSER/work/codecast"
scp -i $KEY -o StrictHostKeyChecking=accept-new /tmp/cc-src.tgz $MUSER@$IP:/tmp/ 2>&1 | tail -1
$SSH "cd /Users/$MUSER/work/codecast && tar -xzf /tmp/cc-src.tgz && rm /tmp/cc-src.tgz"
rm -f /tmp/cc-src.tgz
echo "[5/7] bun install (codecast deps)"
$SSH "export PATH=\"\$HOME/.bun/bin:\$PATH\"; cd /Users/$MUSER/work/codecast && bun install --linker hoisted 2>&1 | tail -2"
echo "[6/7] auth + onboarding"
# CC credential (from local keychain)
security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | $SSH 'umask 077; mkdir -p ~/.claude; cat > ~/.claude/.credentials.json'
# codecast token, through the path `cast hosts provision` uses: an unbound
# token is copied, a device bound one never is (the Mac gets its own, minted
# for its device id, which bun computes on the Mac from its own machine key).
MAC_DEVICE=$($SSH "export PATH=\"\$HOME/.bun/bin:\$PATH\"; cd /Users/$MUSER/work/codecast/packages/cli && bun -e 'import { deviceId } from \"./src/remote/device.ts\"; console.log(deviceId())'" | tail -1)
cd /Users/ashot/src/codecast/packages/cli && MAC_IP=$IP MAC_USER=$MUSER MAC_KEY=$KEY MAC_DEVICE=$MAC_DEVICE bun -e '
import { pushCodecastConfig } from "./src/browser/provisionLinux.ts";
const e = process.env;
await pushCodecastConfig(
  { address: e.MAC_IP, user: e.MAC_USER, keyPath: e.MAC_KEY, remoteBaseDir: `/Users/${e.MAC_USER}/work` },
  { hostDeviceId: () => e.MAC_DEVICE || undefined },
);
' || { echo "codecast config push failed"; exit 1; }
# claude onboarding pre-seed
$SSH 'python3 -c "import json,os; d={\"hasCompletedOnboarding\":True,\"theme\":\"dark\",\"bypassPermissionsModeAccepted\":True,\"projects\":{}}; json.dump(d,open(os.path.expanduser(\"~/.claude.json\"),\"w\"),indent=1)"'
echo "[7/7] start daemon"
bash "$(dirname "$0")/mac-daemon-bootstrap.sh"
echo "=== done: cast remote hosts ==="
cd /Users/ashot/src/codecast/packages/cli && bun run src/index.ts remote hosts
