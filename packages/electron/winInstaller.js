// The Windows half of the desktop updater, as pure functions so they test on
// any host. main.js reads latest.yml (updatePolicy.parseWinFeed), downloads
// the NSIS installer and checks its sha512, then hands it to the commands
// built here.
//
// The handoff is a hidden PowerShell that waits for this process to exit and
// then runs the installer silently. electron-builder's installer takes `/S`
// (silent), `--updated` (an update over an existing install: keep shortcuts
// and settings) and `--force-run` (start Codecast when done). Waiting for our
// own exit first keeps the installer from racing a still-running Codecast.exe
// for its files.

// The publisher the installer's Authenticode signature must name. Null while
// Windows builds ship unsigned (the signing decision is sd-4722); set it to
// the certificate's subject CN in the same change that turns signing on, and
// from then on an installer without that valid signature is refused.
const EXPECTED_PUBLISHER = null;

// A PowerShell single-quoted literal: nothing inside is interpreted.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function powershell(script) {
  return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", script] };
}

// Wait for `pid` to exit, then run `installer` silently; `relaunch` starts
// Codecast again when it finishes (Restart now), otherwise it stays quit.
function installerLaunch({ pid, installer, relaunch }) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${pid}`);
  const args = ["/S", "--updated", ...(relaunch ? ["--force-run"] : [])];
  return powershell(
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
      `Start-Process -FilePath ${psQuote(installer)} -ArgumentList ${args.map(psQuote).join(",")}`,
  );
}

// Prints "<Status>|<signer subject>" for the file's Authenticode signature.
function signatureCheck(file) {
  return powershell(`$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
}

// Whether signatureCheck's output names a valid signature by `publisher`.
// With no publisher configured (unsigned builds) every installer passes.
function signatureAccepted(output, publisher = EXPECTED_PUBLISHER) {
  if (!publisher) return true;
  const [status, subject = ""] = String(output).trim().split("|");
  if (status !== "Valid") return false;
  return subject.split(/,\s*/).some((part) => part === `CN=${publisher}` || part === `CN="${publisher}"`);
}

module.exports = { EXPECTED_PUBLISHER, installerLaunch, signatureCheck, signatureAccepted, psQuote };
