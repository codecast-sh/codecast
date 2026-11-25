#!/bin/bash
# Builds the Windows installer into dist/: NSIS, one click, per-user (installs
# under %LOCALAPPDATA%\Programs\Codecast with no admin prompt), x64. Writes
# Codecast-<version>-x64-setup.exe and latest.yml, the feed the app's own
# updater reads (main.js, winInstaller.js).
#
# Runs on Windows (CI: .github/workflows/desktop-windows.yml) and cross-builds
# from macOS: an unsigned NSIS build needs no wine, because electron-builder
# fetches its own makensis and edits the exe's resources itself.
#
# Signing slot. Windows builds ship unsigned until the signing decision
# (sd-4722) lands; the recommendation there is Azure Trusted Signing. Set
# these and the build signs the app and the installer through electron-
# builder's azureSignOptions, with no other change:
#   AZURE_TRUSTED_SIGNING_ENDPOINT    e.g. https://eus.codesigning.azure.net
#   AZURE_CODE_SIGNING_ACCOUNT        the Trusted Signing account name
#   AZURE_CERT_PROFILE                the certificate profile name
#   AZURE_PUBLISHER_NAME              the certificate's subject CN
#   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET   (Entra app login)
# Trusted Signing runs through PowerShell's TrustedSigning module, so a signed
# build must run on Windows. When signing turns on, set EXPECTED_PUBLISHER in
# winInstaller.js to the same CN so the updater refuses unsigned installers.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f assets/icon.ico ] || scripts/make-icon-ico.sh

# No npm dependency here is native (the one addon is macOS-only and built by
# build-native.sh), so there is nothing to rebuild for Windows, and the
# rebuild step walks the whole workspace's node_modules for nothing.
#
# A per-user one-click install goes to %LOCALAPPDATA%\Programs\<package name>,
# and this package is "@codecast/electron"; the packaged name makes that
# folder Programs\Codecast, the stable path installed-app shortcuts target.
ARGS=(--win nsis --x64 --publish never --config.npmRebuild=false --config.extraMetadata.name=Codecast)
if [ -n "${AZURE_TRUSTED_SIGNING_ENDPOINT:-}" ]; then
  : "${AZURE_CODE_SIGNING_ACCOUNT:?signing needs AZURE_CODE_SIGNING_ACCOUNT}"
  : "${AZURE_CERT_PROFILE:?signing needs AZURE_CERT_PROFILE}"
  : "${AZURE_PUBLISHER_NAME:?signing needs AZURE_PUBLISHER_NAME}"
  : "${AZURE_TENANT_ID:?signing needs AZURE_TENANT_ID}" "${AZURE_CLIENT_ID:?signing needs AZURE_CLIENT_ID}" "${AZURE_CLIENT_SECRET:?signing needs AZURE_CLIENT_SECRET}"
  ARGS+=(
    "--config.win.azureSignOptions.endpoint=$AZURE_TRUSTED_SIGNING_ENDPOINT"
    "--config.win.azureSignOptions.codeSigningAccountName=$AZURE_CODE_SIGNING_ACCOUNT"
    "--config.win.azureSignOptions.certificateProfileName=$AZURE_CERT_PROFILE"
    "--config.win.azureSignOptions.publisherName=$AZURE_PUBLISHER_NAME"
  )
  echo "build-win: signing with Azure Trusted Signing ($AZURE_CODE_SIGNING_ACCOUNT/$AZURE_CERT_PROFILE)"
else
  echo "build-win: building UNSIGNED (no AZURE_TRUSTED_SIGNING_ENDPOINT; see sd-4722)"
fi

exec npx electron-builder "${ARGS[@]}" "$@"
