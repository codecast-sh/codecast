import * as fs from "node:fs";
import * as path from "node:path";

export const FAKE_BOX = { id: "box123", name: "cast-box", site: "iad", instance_shape: { virtual_cpu: 2, memory_megabytes: 4096 }, spec: { remote_user: "devbox" } };

const RECORD = `{ printf '%s\\n' "$BIN"; for a in "$@"; do printf '%s\\n' "$a"; done; printf '\\036\\n'; } >> "$FAKE_NS/argv.log"`;

const DEVBOX = `#!/bin/sh
IFS='|'
BIN=devbox
${RECORD}
echo "devbox|$*" >> "$FAKE_NS/calls.log"
if [ -e "$FAKE_NS/devbox-fail" ]; then echo "devbox: boom" >&2; exit 2; fi
case "$1" in
  service)
    svc="$FAKE_NS/services"
    touch "$svc"
    sub=$2
    box=$3
    case "$sub" in
      create)
        name=$5
        if grep -qx "$name" "$svc"; then echo "Service $name already exists on $box" >&2; exit 1; fi
        echo "$name" >> "$svc";;
      delete|start|stop)
        name=$4
        if ! grep -qx "$name" "$svc"; then echo "No service \\"$name\\" on $box" >&2; exit 1; fi
        if [ "$sub" = delete ]; then grep -vx "$name" "$svc" > "$svc.tmp"; mv "$svc.tmp" "$svc"; fi;;
      list)
        if [ -e "$FAKE_NS/service-list-garbage" ]; then echo 'not json'; exit 0; fi
        printf '{"services":['
        sep=
        while read -r name; do printf '%s{"name":"%s","status":"running","command":["sh","-c"]}' "$sep" "$name"; sep=,; done < "$svc"
        printf ']}\n';;
    esac;;
  list) if [ -e "$FAKE_NS/devbox-list" ]; then cat "$FAKE_NS/devbox-list"; else echo '[]'; fi;;
  create)
    printf '[{"id":"box123","name":"%s","site":"iad","instance_shape":{"virtual_cpu":2,"memory_megabytes":4096},"spec":{"remote_user":"devbox"}}]' "$3" > "$FAKE_NS/devbox-list"
    mkdir -p "$HOME/.namespace/ssh"
    : > "$HOME/.namespace/ssh/$3.devbox.namespace.key"
    : > "$HOME/.namespace/ssh/$3.devbox.namespace.ssh";;
esac
`;

const SSH = `#!/bin/sh
BIN=ssh
n=$(( $(grep -c '^ssh$' "$FAKE_NS/argv.log" 2>/dev/null || true) + 1 ))
${RECORD}
if [ -e "$FAKE_NS/ssh-fail" ]; then echo "ssh: refused" >&2; exit 255; fi
for last in "$@"; do :; done
case " $* " in *" -O "*) exit 0;; esac
in=$(cat)
printf '%s' "$in" > "$FAKE_NS/stdin-$n"
case "$in" in *"echo PROVISION-BASE-OK"*) echo PROVISION-BASE-OK;; esac
case "$in" in *"CAST-RELEASE="*) echo "CAST-RELEASE=\${FAKE_CAST_VERSION:-1.2.3}";; esac
case "$in" in *DAEMON-PREP-OK*) echo DAEMON-PREP-OK;; esac
case "$last" in *DAEMON-PID*) echo "DAEMON-PID=4242";; esac
`;

const NSC = `#!/bin/sh
IFS='|'
BIN=nsc
${RECORD}
echo "nsc|$*" >> "$FAKE_NS/calls.log"
if [ -e "$FAKE_NS/nsc-fail" ]; then echo "nsc: not logged in" >&2; exit 1; fi
if [ -e "$FAKE_NS/nsc-list" ]; then cat "$FAKE_NS/nsc-list"; else echo null; fi
`;

export function installFakeNamespace(root: string, opts: { ssh?: boolean } = {}): { home: string; bin: string; state: string; calls: () => string[][]; argv: () => string[][]; stdins: () => string[]; set: (file: string, body?: string) => void } {
  const home = path.join(root, "home");
  const bin = path.join(home, ".local", "bin");
  const state = path.join(root, "ns");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(bin, "devbox"), DEVBOX, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "nsc"), NSC, { mode: 0o755 });
  if (opts.ssh) fs.writeFileSync(path.join(bin, "ssh"), SSH, { mode: 0o755 });
  const log = path.join(state, "calls.log");
  const argvLog = path.join(state, "argv.log");
  return {
    home, bin, state,
    argv: () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf-8").split("\x1e\n").filter(Boolean).map((r) => r.replace(/\n$/, "").split("\n")) : []),
    stdins: () => fs.readdirSync(state).filter((f) => f.startsWith("stdin-")).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))).map((f) => fs.readFileSync(path.join(state, f), "utf-8")),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split("|")) : []),
    set: (file, body = "") => fs.writeFileSync(path.join(state, file), body),
  };
}
