/**
 * The host side of the agent auth push: a python3 program run on the remote
 * as `umask 077; python3 -c <script>` with the AgentAuthBundle JSON on stdin
 * (remote/agentAuth.ts). python3 is the runtime ensureRemoteClaudeReady
 * already relies on, on Linux and the Scaleway Macs; `-c` rather than a
 * heredoc because the heredoc would take the stdin the bundle needs.
 *
 * What it does, in order, and only under ~/.codecast/mirror.lock (the same
 * O_EXCL pid+token protocol as cloud/mirror/apply.ts withMirrorLock and the
 * host git script, since settings.json and config.toml have other writers):
 *   1. identity: the bundle's user_id must match `user_id` in the host's
 *      ~/.codecast/config.json (the identity the daemon runs as); when that
 *      file has none, the ~/.codecast/agent-auth-origin.json stamp decides.
 *      A mismatch prints `refused:other-user` and exits 3 before any write.
 *   2. files: written atomically at 0600 into 0700 dirs; a symlinked path
 *      component or a non-regular existing target is refused. The host's
 *      ~/.codex/auth.json is KEPT when its `last_refresh` is newer than the
 *      bundle's (`kept:codex host-fresher`): a codex session on the host may
 *      have rotated the grant, and overwriting it would kill both copies.
 *   3. absent: a file the laptop no longer has is unlinked only when the
 *      stamp (step 6) says THIS device pushed it: a second laptop of the
 *      same user, or a login made on the host itself, is never deleted by a
 *      laptop that lacks the file. Whenever codex auth is written or
 *      removed, the host's codex profile snapshots (~/.codecast/codex-
 *      accounts, codex-accounts.json, codex-usage-accounts.json) go — the
 *      host never meters accounts.
 *   4. env: when the bundle has a `claudeEnv` key, its keys are merged into
 *      ~/.claude/settings.json's env (read-merge-write, indent preserved),
 *      keys the manifest ~/.codecast/mirrored-claude-env.json listed before
 *      but the bundle no longer carries are removed, everything else stays,
 *      the file goes 0600 once it carries a mirrored key.
 *   5. trust: `[projects."<path>"] trust_level = "trusted"` is appended to
 *      ~/.codex/config.toml for each codexTrustPaths entry that lacks one.
 *   6. stamp: bundles that carry files/absent/claudeEnv write
 *      ~/.codecast/agent-auth-origin.json — user_id, the last pushing
 *      device, and `files`: path → the device that last wrote it (entries
 *      of other devices survive a push that does not carry their file); a
 *      trust-only bundle does not.
 * Last line: `applied files=<n> kept=<a,b> deleted=<n> env=<k1,k2> trust=<n>`;
 * a failure that escapes a step still prints every `error:` line collected
 * plus `error:receiver:<why>` before exiting 1, so the laptop can say why.
 */

export const AGENT_AUTH_RECEIVER = `
import json, os, sys, time, re, shutil, calendar, errno

HOME = os.path.expanduser("~")
CODECAST = os.path.join(HOME, ".codecast")
LOCK = os.path.join(CODECAST, "mirror.lock")
LOCK_WAIT = float(os.environ.get("CAST_MIRROR_LOCK_WAIT", "60"))
errors = []

def out(line):
    sys.stdout.write(line + "\\n")

def home_path(rel):
    if not isinstance(rel, str) or not rel.startswith("~/"):
        raise ValueError("not a ~/ path")
    parts = rel[2:].split("/")
    if not parts or any(p in ("", ".", "..") for p in parts):
        raise ValueError("unsafe path")
    return os.path.join(HOME, *parts)

def check_components(dest):
    # Every existing component below HOME must be a real directory; the target,
    # when it exists, a regular file (receiveFile's rule in cloud/transfer.ts).
    rel = os.path.relpath(dest, HOME)
    cur = HOME
    for part in rel.split(os.sep)[:-1]:
        cur = os.path.join(cur, part)
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            return
        if not os.path.isdir(cur) or os.path.islink(cur):
            raise ValueError("unsafe destination directory")
    try:
        st = os.lstat(dest)
    except FileNotFoundError:
        return
    if os.path.islink(dest) or not os.path.isfile(dest):
        raise ValueError("unsafe destination file")

def mkdirs(d):
    rel = os.path.relpath(d, HOME)
    cur = HOME
    for part in rel.split(os.sep):
        if part in ("", "."):
            continue
        cur = os.path.join(cur, part)
        if not os.path.lexists(cur):
            os.mkdir(cur, 0o700)
        elif os.path.islink(cur) or not os.path.isdir(cur):
            raise ValueError("unsafe destination directory")

def write_atomic(dest, data, mode=0o600):
    d = os.path.dirname(dest)
    mkdirs(d)
    check_components(dest)
    tmp = os.path.join(d, ".cast-auth-%d" % os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, dest)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    try:
        os.chmod(dest, mode)
    except OSError:
        pass

def read_json(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return None

ISO = re.compile(r"^(\\d{4})-(\\d{2})-(\\d{2})[T ](\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?\\s*(Z|[+-]\\d{2}:?\\d{2})?$")

def iso_ms(s):
    if not isinstance(s, str):
        return None
    m = ISO.match(s.strip())
    if not m:
        return None
    y, mo, d, h, mi, se = (int(m.group(i)) for i in range(1, 7))
    frac = m.group(7) or ""
    ms = int((frac + "000")[:3]) if frac else 0
    base = calendar.timegm((y, mo, d, h, mi, se)) * 1000 + ms
    tz = m.group(8)
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        hh = int(tz[1:3]); mm = int(tz[-2:])
        base -= sign * (hh * 60 + mm) * 60 * 1000
    return base

def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True

def acquire_lock():
    mkdirs(CODECAST)
    token = "auth-%d-%d" % (os.getpid(), int(time.time() * 1000))
    deadline = time.time() + LOCK_WAIT
    while True:
        try:
            fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps({"pid": os.getpid(), "token": token, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))
            return token
        except FileExistsError:
            pass
        stale = False
        seen = None
        try:
            with open(LOCK) as f:
                seen = f.read()
            holder = json.loads(seen)
            pid = holder.get("pid") if isinstance(holder, dict) else None
            if isinstance(pid, int) and pid > 0 and not pid_alive(pid):
                stale = True
        except Exception:
            try:
                if time.time() - os.stat(LOCK).st_mtime > 5:
                    stale = True
            except OSError:
                continue
        if stale:
            try:
                cur = None
                try:
                    with open(LOCK) as f:
                        cur = f.read()
                except Exception:
                    cur = None
                if seen is None or cur == seen:
                    os.unlink(LOCK)
            except OSError:
                pass
            continue
        if time.time() > deadline:
            raise RuntimeError("mirror lock %s is held" % LOCK)
        time.sleep(0.25)

def release_lock(token):
    try:
        with open(LOCK) as f:
            if json.load(f).get("token") == token:
                os.unlink(LOCK)
    except Exception:
        pass

def main():
    raw = sys.stdin.read()
    try:
        bundle = json.loads(raw)
    except Exception:
        out("error:bundle:invalid json")
        return 1
    if not isinstance(bundle, dict) or not isinstance(bundle.get("origin"), dict):
        out("error:bundle:malformed")
        return 1
    origin = bundle["origin"]
    user_id = origin.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        out("error:bundle:no user_id")
        return 1
    files = bundle.get("files") or []
    absent = bundle.get("absent") or []
    trust = bundle.get("codexTrustPaths") or []
    has_env = "claudeEnv" in bundle and isinstance(bundle.get("claudeEnv"), dict)
    stamping = bool(files) or bool(absent) or has_env

    # 1. identity — before anything is written.
    cfg = read_json(os.path.join(CODECAST, "config.json"))
    cfg_user = cfg.get("user_id") if isinstance(cfg, dict) else None
    if isinstance(cfg_user, str) and cfg_user:
        if cfg_user != user_id:
            out("refused:other-user")
            return 3
    else:
        stamp = read_json(os.path.join(CODECAST, "agent-auth-origin.json"))
        stamp_user = stamp.get("user_id") if isinstance(stamp, dict) else None
        if isinstance(stamp_user, str) and stamp_user and stamp_user != user_id:
            out("refused:other-user")
            return 3

    device_id = origin.get("device_id") if isinstance(origin.get("device_id"), str) else None
    # Which device last wrote each path on this host (the stamp's files;
    # an older list-shaped stamp means "all by the stamp's device").
    stamp_path = os.path.join(CODECAST, "agent-auth-origin.json")
    prior_stamp = read_json(stamp_path)
    owners = {}
    if isinstance(prior_stamp, dict):
        pf = prior_stamp.get("files")
        if isinstance(pf, dict):
            owners = {k: v for k, v in pf.items() if isinstance(k, str) and isinstance(v, str)}
        elif isinstance(pf, list) and isinstance(prior_stamp.get("device_id"), str):
            owners = {k: prior_stamp["device_id"] for k in pf if isinstance(k, str)}

    try:
        token = acquire_lock()
    except Exception as e:
        out("error:lock:%s" % e)
        return 1
    written = 0
    kept = []
    deleted = 0
    env_keys = []
    trust_added = 0
    codex_touched = False
    try:
        # 2. files
        for f in files:
            try:
                rel = f.get("path")
                dest = home_path(rel)
                content = f.get("content")
                if not isinstance(content, str):
                    raise ValueError("content is not a string")
                if rel == "~/.codex/auth.json":
                    cur = read_json(dest) if os.path.isfile(dest) and not os.path.islink(dest) else None
                    host_ms = iso_ms(cur.get("last_refresh")) if isinstance(cur, dict) else None
                    mine = f.get("last_refresh")
                    if host_ms is not None and isinstance(mine, (int, float)) and host_ms > mine:
                        kept.append("codex:host-fresher")
                        continue
                write_atomic(dest, content, 0o600)
                written += 1
                if rel == "~/.codex/auth.json":
                    codex_touched = True
                if device_id:
                    owners[rel] = device_id
            except Exception as e:
                errors.append("%s:%s" % (f.get("path") if isinstance(f, dict) else "?", e))
        # 3. absent — only what this device itself pushed.
        for rel in absent:
            try:
                dest = home_path(rel)
                if not device_id or owners.get(rel) != device_id:
                    continue
                if os.path.lexists(dest):
                    if os.path.islink(dest) or not os.path.isfile(dest):
                        raise ValueError("not a regular file")
                    os.unlink(dest)
                    deleted += 1
                    if rel == "~/.codex/auth.json":
                        codex_touched = True
                del owners[rel]
            except Exception as e:
                errors.append("%s:%s" % (rel, e))
        if codex_touched:
            for p in ("codex-accounts.json", "codex-usage-accounts.json"):
                try:
                    os.unlink(os.path.join(CODECAST, p))
                except FileNotFoundError:
                    pass
                except OSError as e:
                    errors.append("%s:%s" % (p, e))
            snaps = os.path.join(CODECAST, "codex-accounts")
            if os.path.isdir(snaps) and not os.path.islink(snaps):
                shutil.rmtree(snaps, ignore_errors=True)
        # 4. env merge
        if has_env:
            try:
                wanted = {k: v for k, v in bundle["claudeEnv"].items() if isinstance(k, str) and isinstance(v, str)}
                settings_path = os.path.join(HOME, ".claude", "settings.json")
                manifest_path = os.path.join(CODECAST, "mirrored-claude-env.json")
                prior = read_json(manifest_path)
                if isinstance(prior, dict):
                    prior = prior.get("keys", list(prior.keys()))
                prior = [k for k in (prior or []) if isinstance(k, str)] if isinstance(prior, list) else []
                text = None
                exists = os.path.isfile(settings_path) and not os.path.islink(settings_path)
                if exists:
                    try:
                        with open(settings_path) as fh:
                            text = fh.read()
                    except Exception as e:
                        errors.append("settings.json:%s" % e)
                        text = None
                settings = {}
                unparseable = False
                if text is not None:
                    try:
                        settings = json.loads(text)
                        if not isinstance(settings, dict):
                            unparseable = True
                    except Exception:
                        unparseable = True
                if unparseable:
                    out("settings:unparseable")
                elif exists or wanted or prior:
                    env = settings.get("env")
                    had_env = isinstance(env, dict)
                    env = dict(env) if had_env else {}
                    changed = False
                    for k in prior:
                        if k not in wanted and k in env:
                            del env[k]
                            changed = True
                    for k, v in wanted.items():
                        if env.get(k) != v:
                            env[k] = v
                            changed = True
                    if env or had_env:
                        settings["env"] = env
                    elif "env" in settings:
                        del settings["env"]
                    mirrored = sorted(k for k in wanted if k in env)
                    if changed or not exists:
                        indent = 4
                        if text is not None:
                            m = re.match(r"^\\{\\n( +)\\"", text)
                            if m:
                                indent = len(m.group(1))
                        body = json.dumps(settings, indent=indent, ensure_ascii=False)
                        if text is not None and text.endswith("\\n"):
                            body += "\\n"
                        mode = 0o600 if mirrored else (0o644 if not exists else None)
                        if mode is None:
                            try:
                                mode = os.stat(settings_path).st_mode & 0o777
                            except OSError:
                                mode = 0o644
                        write_atomic(settings_path, body, mode)
                    elif mirrored:
                        try:
                            if os.stat(settings_path).st_mode & 0o777 != 0o600:
                                os.chmod(settings_path, 0o600)
                        except OSError:
                            pass
                    env_keys = mirrored
                    write_atomic(manifest_path, json.dumps(mirrored) + "\\n", 0o600)
            except Exception as e:
                errors.append("settings.json:%s" % e)
        # 5. trust
        if trust:
            codex_dir = os.path.join(HOME, ".codex")
            toml_path = os.path.join(codex_dir, "config.toml")
            try:
                mkdirs(codex_dir)
                toml = ""
                if os.path.isfile(toml_path) and not os.path.islink(toml_path):
                    with open(toml_path) as fh:
                        toml = fh.read()
                lines = set(l.strip() for l in toml.split("\\n"))
                add = ""
                for p in trust:
                    if not isinstance(p, str) or not p.startswith("/") or "\\n" in p or "\\r" in p or "\\0" in p:
                        errors.append("trust:%r:unsafe path" % (p,))
                        continue
                    header = '[projects."%s"]' % p.replace("\\\\", "\\\\\\\\").replace('"', '\\\\"')
                    if header in lines:
                        continue
                    add += "\\n%s\\ntrust_level = \\"trusted\\"\\n" % header
                    lines.add(header)
                    trust_added += 1
                if add:
                    if toml and not toml.endswith("\\n"):
                        toml += "\\n"
                    write_atomic(toml_path, toml + add, 0o600)
            except Exception as e:
                errors.append("trust:%s" % e)
        # 6. stamp
        if stamping:
            try:
                stamp = {"user_id": user_id, "device_id": device_id, "pushed_at": origin.get("pushed_at"), "files": owners}
                write_atomic(stamp_path, json.dumps(stamp, indent=2, sort_keys=True) + "\\n", 0o600)
            except Exception as e:
                errors.append("stamp:%s" % e)
    except Exception as e:
        errors.append("receiver:%s: %s" % (type(e).__name__, e))
        for err in errors:
            out("error:" + str(err).replace("\\n", " "))
        return 1
    finally:
        release_lock(token)
    for e in errors:
        out("error:" + str(e).replace("\\n", " "))
    out("applied files=%d kept=%s deleted=%d env=%s trust=%d" % (written, ",".join(kept), deleted, ",".join(env_keys), trust_added))
    return 0

sys.exit(main())
`;
