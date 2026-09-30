#!/bin/bash
# End to end check of `cast computer` on Linux (X11 + AT-SPI), run ON a host.
#
#   bash computer-linux-e2e.sh [cast command]     default: cast
#
# Starts a Chrome page and gtk3-widget-factory on the host display (each with
# nothing but DISPLAY, the way an agent starts an app), drives every verb
# through the real CLI from the daemon's bare environment, and last runs one
# read as a system service with no login, the daemon's own context. Needs the
# packages provisionLinux.ts installs, plus google-chrome and gtk-3-examples.
set -u
CAST=${1:-cast}
C(){ env -u DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u XDG_RUNTIME_DIR -u AT_SPI_BUS_ADDRESS $CAST "$@"; }
C=C
PAGE=$(mktemp -d)/cc-page.html
cat > "$PAGE" <<'HTML'
<!doctype html><title>CC Test</title>
<h1>Computer test</h1>
<p>Hello <a href="https://example.test/docs">docs link</a> world.</p>
<label>Name <input id=name placeholder="your name"></label>
<label>Secret <input type=password id=pw placeholder="password"></label>
<label><input type=checkbox id=agree> Agree</label>
<select id=color><option>red</option><option>green</option></select>
<textarea id=notes rows=3>first line</textarea>
<button onclick="document.getElementById('out').textContent='clicked '+document.getElementById('name').value">Go</button>
<div id=out>idle</div>
<ul>
<li>item 1</li>
<li>item 2</li>
<li>item 3</li>
<li>item 4</li>
<li>item 5</li>
<li>item 6</li>
<li>item 7</li>
<li>item 8</li>
<li>item 9</li>
<li>item 10</li>
<li>item 11</li>
<li>item 12</li>
<li>item 13</li>
<li>item 14</li>
<li>item 15</li>
<li>item 16</li>
<li>item 17</li>
<li>item 18</li>
<li>item 19</li>
<li>item 20</li>
<li>item 21</li>
<li>item 22</li>
<li>item 23</li>
<li>item 24</li>
<li>item 25</li>
<li>item 26</li>
<li>item 27</li>
<li>item 28</li>
<li>item 29</li>
<li>item 30</li>
<li>item 31</li>
<li>item 32</li>
<li>item 33</li>
<li>item 34</li>
<li>item 35</li>
<li>item 36</li>
<li>item 37</li>
<li>item 38</li>
<li>item 39</li>
<li>item 40</li>
</ul>
HTML
pass=0; fail=0
ok(){ echo "PASS  $1"; pass=$((pass+1)); }
bad(){ echo "FAIL  $1"; echo "$2" | sed 's/^/      /' | head -8; fail=$((fail+1)); }
check(){ local name=$1 want=$2; shift 2; local out; out=$("$@" 2>&1); if echo "$out" | grep -qE -- "$want"; then ok "$name"; else bad "$name" "$out"; fi; }
H=${CODECAST_DIR:-$HOME/.codecast}/computer/instance.json
helper_pid(){ python3 -c "import json;print(json.load(open('$H'))['pid'])" 2>/dev/null; }
kill $(helper_pid) 2>/dev/null; sleep 1

# Fixtures: a Chrome page and a GTK3 app, each started with nothing but DISPLAY.
for p in $(pgrep -f "cc-[c]hrome"); do kill $p 2>/dev/null; done
for p in $(pgrep -x gtk3-widget-fac); do kill $p; done
sleep 1; rm -rf /tmp/cc-chrome
env -i HOME=$HOME PATH=/usr/bin:/bin DISPLAY=:99 setsid google-chrome --user-data-dir=/tmp/cc-chrome --no-first-run --no-default-browser-check --window-position=40,40 --window-size=1000,800 file://$PAGE >/dev/null 2>&1 < /dev/null &
env -i HOME=$HOME PATH=/usr/bin:/bin DISPLAY=:99 setsid gtk3-widget-factory >/dev/null 2>&1 < /dev/null &
sleep 8
CH="--app pid:$(ps -eo pid,args | grep -E '[c]hrome.*cc-chrome' | grep -v type= | awk '{print $1}' | head -1)"
G="--app gtk3-widget-factory"

check "capabilities report linux"          "on linux \(protocol 1\)"                $C computer capabilities
check "permissions granted"               "accessibility=granted, screenshots=granted" $C computer permissions
check "list-apps sees both fixtures"      "gtk3-widget-factory"                     $C computer list-apps
check "list-windows"                      "\[0\] id:[0-9]+ \"CC Test"               $C computer list-windows $CH
check "chrome tree without the flag"      "button Go"                               $C computer get-app-state $CH --restore-window
check "screenshot captured"               "Screenshot captured \(png.*x11"          $C computer get-app-state $CH
check "set-value (typed, verified)"       "verified \(value\)"                      $C computer set-value $CH --element "text field (settable) Name" --value "Linus"
check "click by name (press)"             "clicked Linus"                           $C computer click $CH --element "button Go"
check "wait for text"                     "appeared after"                          $C computer wait $CH --text "clicked Linus" --timeout 5
C computer set-value $CH --element "secure text field" --value hunter2 >/dev/null
check "secure field redacted"             "Secret \[redacted\]"                      $C computer find "Secret" $CH
check "click focuses textarea"            "focused UI element is [0-9]+ text field \(settable\) first line" $C computer click $CH --element "text field (settable) first line"
check "select all (accessibility)"        "selectAll\), verified \(selection\)"     $C computer hotkey $CH --key CmdOrCtrl+A
check "type-text (verified)"              "verified \(focused text\)"               $C computer type-text $CH --text "abc"
check "press-key"                         "Press key attempted via synthetic"       $C computer press-key $CH --key End
check "paste from stdin"                  "abc\+stdin"                              C computer paste-text $CH --text-stdin <<< "+stdin"
check "checkbox by mouse"                 "check box Agree, Value: 1"               $C computer click $CH --element "check box Agree" --mouse
check "secondary action scroll"           "Secondary action attempted .*scroll down" $C computer perform-secondary-action $CH --element "html content" --action "scroll down"
check "scroll by wheel"                   "Scroll attempted via synthetic"          $C computer scroll $CH --element "html content" --direction up --pages 3
check "diff since last snapshot"          "Changes:|No change"                      $C computer get-app-state $CH --diff --no-screenshot
check "stale index refused"               "is stale"                                $C computer click $CH --element-index 9999
check "unfocused keyboard refused"        "does not have keyboard focus"            $C computer type-text $G --text x
check "gtk tree"                          "slider"                                  $C computer get-app-state $G --restore-window --no-screenshot
check "gtk set-value (EditableText)"      "setTextContents\), verified \(value\)"   $C computer set-value $G --element "text field (settable) entry" --value "native"
check "gtk slider set-value"              "setCurrentValue\), verified \(value\)"   $C computer set-value $G --element "slider, Value: 50" --value 20
check "gtk checkbox click (action)"       "via accessibility \(click\)"             $C computer click $G --element "check box checkbutton, Value: 0" --nth 1
check "gtk typing once focused"           "text field \(settable\) nativeX|verified" $C computer type-text $G --text X
check "blocked app refused"               "blocked for safety"                      $C computer get-app-state --app KeePassXC
P1=$(helper_pid); $C computer list-apps >/dev/null; P2=$(helper_pid)
[ -n "$P1" ] && [ "$P1" = "$P2" ] && ok "helper reused across commands ($P1)" || bad "helper reused" "$P1 vs $P2"
kill $(helper_pid) 2>/dev/null; sleep 1
check "daemon context (system service, no login env)" "button Go" sudo -n systemd-run --uid="$(id -u)" --gid="$(id -g)" --pipe --wait --quiet -p Environment=HOME="$HOME" -p Environment=PATH="$PATH" $CAST computer find "button Go" $CH
for p in $(pgrep -f "cc-[c]hrome"); do kill $p 2>/dev/null; done
for p in $(pgrep -x gtk3-widget-fac); do kill $p; done
rm -rf /tmp/cc-chrome "$(dirname "$PAGE")"
echo "== $pass passed, $fail failed"
[ "$fail" = 0 ]
