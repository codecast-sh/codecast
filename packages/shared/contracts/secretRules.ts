// The Vault's pure rules, shared by the CLI, the server and the web: a
// secret's name and its env var, which names carry credentials, how short or
// long a value the daemon redacts, and .env parsing. No imports, so a caller
// on every cast command (the workspace manifest, transcript redaction) does
// not load the Vault contract with them. secrets.ts re-exports all of it.

/** A secret's name: what agents type, so a lowercase slug (`stripe-test`). */
export const SECRET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A ref the backend reads as an id before a name: a short id (`sec-4`) or a Convex id (32 lowercase letters and digits, entities isConvexId). */
const ID_SHAPED_RE = /^(?:sec-\d+|[a-z0-9]{32})$/;

export function secretNameProblem(name: string): string | null {
  if (!SECRET_NAME_RE.test(name)) return `"${name}" is not a secret name: use 1 to 63 lowercase letters, digits and dashes, like stripe-test`;
  if (ID_SHAPED_RE.test(name)) return `"${name}" reads as a secret's id, so it would never be found by name: pick a name that says what it is, like stripe-test`;
  return null;
}

// Env vars that make a shell, a loader, an interpreter or a build tool run
// code, read its config, trust a certificate or route its traffic from
// wherever the value points. A team secret fills its teammates' process env
// (`vault run`, `vault env`, `cast dev`), so it never names one. This is a
// blocklist of the known names and naming families: a tool's variable that
// matches none of them gets through, so add it here when one turns up.
const LOADER_ENV = new Set([
  "PATH", "IFS", "ENV", "BASH_ENV", "SHELL", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE",
  "ZDOTDIR", "TMPDIR", "TMP", "TEMP", "TERMINFO", "MAKEFILES", "DENO_DIR", "NVM_DIR",
  "NODE_PATH", "NODE_TLS_REJECT_UNAUTHORIZED", "RUBYOPT", "RUBYLIB", "GEM_PATH", "PERLLIB", "CLASSPATH",
  "PHPRC", "PHP_INI_SCAN_DIR", "LUA_INIT", "LUA_PATH", "LUA_CPATH", "TCLLIBPATH",
  "CPATH", "C_INCLUDE_PATH", "CPLUS_INCLUDE_PATH", "LIBRARY_PATH", "CMAKE_PREFIX_PATH", "CMAKE_MODULE_PATH",
  "GCONV_PATH", "HOSTALIASES", "RESOLV_HOST_CONF", "LOCALDOMAIN", "LOCPATH", "NLSPATH", "OPENSSL_CONF", "OPENSSL_ENGINES", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE", "BROWSER", "SSH_ASKPASS", "SUDO_ASKPASS", "SSH_AUTH_SOCK",
  "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
  "GIT_PAGER", "GIT_EXTERNAL_DIFF", "GIT_PROXY_COMMAND", "GIT_DIR", "GIT_WORK_TREE", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_SSL_NO_VERIFY",
  "CC", "CXX", "CPP", "LD", "AR", "AS", "NM", "RANLIB", "MAKE", "RUSTC", "RUSTDOC",
  "GOPATH", "GOROOT", "GOBIN", "GOENV", "GOTOOLCHAIN", "GOPRIVATE", "GONOSUMDB", "GONOSUMCHECK", "GOINSECURE", "GOSUMDB", "GOEXPERIMENT",
  "AWS_SHARED_CREDENTIALS_FILE", "WGETRC", "NETRC",
]);
const LOADER_ENV_PREFIX = /^(?:LD_|DYLD_|PYTHON|PERL5|BASH_FUNC_|GIT_CONFIG|NPM_CONFIG_|LUA_INIT_|XDG_|AWS_ENDPOINT_URL|RUSTUP_|PIP_|UV_|DOCKER_HOST|DOCKER_TLS|DOCKER_CERT_PATH)/;
// Any word of the name that points a tool at a proxy, a CA bundle, a wrapper, extra flags or options
// (MAVEN_OPTS, BUN_OPTIONS), a config file, or a home or search directory it loads from.
const LOADER_ENV_WORD = /(?:^|_)(?:[A-Z]*PROXY|CA|CAINFO|CAPATH|BUNDLE|[A-Z]*WRAPPER|[A-Z]*FLAGS|[A-Z]*OPTS|[A-Z]*OPTIONS|[A-Z]*CONFIG|[A-Z]*HOME|[A-Z]*DIRS)(?:_|$)/;
// Cargo reads its whole config from CARGO_*; only a registry token is a credential.
const CARGO_ENV = /^CARGO_(?!.*_TOKEN$)/;

/** Why a name cannot be a secret's env var: `problem` fits under a field, `why` is the reason a form keeps behind a help icon. */
export type EnvNameIssue = { problem: string; why?: string };

export function envNameIssue(name: string): EnvNameIssue | null {
  if (!ENV_NAME_RE.test(name)) return { problem: `"${name}" is not an env var name: use letters, digits and underscores, starting with a letter, like STRIPE_SECRET_KEY` };
  const upper = name.toUpperCase();
  if (LOADER_ENV.has(upper) || LOADER_ENV_PREFIX.test(upper) || LOADER_ENV_WORD.test(upper) || CARGO_ENV.test(upper)) {
    return {
      problem: `${name} is reserved; use your own name, like STRIPE_SECRET_KEY`,
      why: `${name} tells a shell, an interpreter or a tool what code to load, what to trust or where to connect, so a secret cannot set it`,
    };
  }
  return null;
}

/** The issue as one sentence, for a CLI or server error. */
export function envNameProblem(name: string): string | null {
  const issue = envNameIssue(name);
  if (!issue) return null;
  return issue.why ? `${issue.why}: give the secret a variable of its own, like STRIPE_SECRET_KEY` : issue.problem;
}

/** The daemon exact-matches values up to this length (knownValueRedaction);
 *  a longer value goes to it in SECRET_REDACTION_CHUNK pieces (redactionValuesOf). */
export const SECRET_REDACTION_MAX = 8192;
/** The shortest value the daemon redacts: below it even a Vault value would blank ordinary text (a 4-digit PIN in every year). A key must be at least this long. */
export const SECRET_REDACTION_MIN = 6;

/** Variable and field names whose values are credentials. AUTH excludes AUTHOR (GIT_AUTHOR_NAME); a bare KEY is too common (PRIMARY_KEY) to count. */
const CREDENTIAL_NAME_RE = /SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTH(?!OR)/i;
export const isCredentialName = (name: string) => CREDENTIAL_NAME_RE.test(name);

// .env files

const DOTENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/;
const DOTENV_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * One .env line's name and value, or null when it is not an assignment
 * (`KEY=value`, `export KEY=value`). Inside double quotes `\n`, `\r`, `\t`,
 * `\"` and `\\` are escapes; single quotes and backticks keep everything
 * literal; an unquoted value (or one whose quote never closes) ends at ` #`
 * and is trimmed. Names may carry `.` and `-`, which no env var can:
 * dotenvVars leaves those out.
 */
export function parseDotenvLine(line: string): [string, string] | null {
  const m = DOTENV_LINE_RE.exec(line);
  if (!m) return null;
  const name = m[1]!;
  const raw = m[2]!.trim();
  const q = raw[0];
  if (q === '"') {
    let out = "";
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === '"') return [name, out];
      if (c === "\\" && i + 1 < raw.length) {
        const next = raw[++i]!;
        out += DOTENV_ESCAPES[next] ?? `\\${next}`;
      } else out += c;
    }
  } else if (q === "'" || q === "`") {
    const end = raw.indexOf(q, 1);
    if (end > 0) return [name, raw.slice(1, end)];
  }
  return [name, raw.replace(/\s+#.*$/, "").trim()];
}

/** Every assignment in .env text, in order; a name given twice is kept twice. The daemon's redaction reads every one. */
export function parseDotenv(text: string): Array<[string, string]> {
  return text.split(/\r?\n/).flatMap((line) => {
    const pair = parseDotenvLine(line);
    return pair ? [pair] : [];
  });
}
