import json
import os
import pty
import select
import signal
import subprocess
import sys
import time

with open(sys.argv[1]) as config:
    options = json.load(config)
env = options["env"]
mode = options["mode"]
command = ["sh", "-c", 'cat "$1" | sh -s -- "$2"', "installer-test", options["script"], options["token"]]

def report(status, output):
    with open(options["report"], "w") as result:
        json.dump({"status": status, "output": output.decode(errors="replace")}, result)

if mode == "headless":
    result = subprocess.run(command, env=env, cwd=env["HOME"], capture_output=True, start_new_session=True, timeout=20)
    report(result.returncode, result.stdout + result.stderr)
    sys.exit(0)

if mode == "direct":
    command = ["sh", options["script"], options["token"]]

pid, fd = pty.fork()
if pid == 0:
    os.chdir(env["HOME"])
    if mode in ("stdout-only", "stderr-only"):
        redirected = os.open(os.path.join(env["HOME"], "redirected.log"), os.O_WRONLY | os.O_CREAT, 0o600)
        os.dup2(redirected, 2 if mode == "stdout-only" else 1)
        os.close(redirected)
    os.execvpe(command[0], command, env)

output = b""
status = None
answers = [(b"Sync all projects? (recommended)", b"n\r"), (b"Keep agent memory enabled?", b"\r")]
started = time.monotonic()
try:
    while time.monotonic() - started < 20:
        readable, _, _ = select.select([fd], [], [], 0.05)
        if readable:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        transcript = output
        redirected_path = os.path.join(env["HOME"], "redirected.log")
        if os.path.exists(redirected_path):
            with open(redirected_path, "rb") as redirected:
                transcript += redirected.read()
        if answers and answers[0][0] in transcript:
            time.sleep(0.1)
            os.write(fd, answers.pop(0)[1])
        exited, state = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = os.waitstatus_to_exitcode(state)
            break
finally:
    if status is None:
        exited, state = os.waitpid(pid, os.WNOHANG)
        if not exited:
            os.killpg(pid, signal.SIGKILL)
            _, state = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(state)
    os.close(fd)

report(status, output)
