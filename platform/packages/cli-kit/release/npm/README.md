# npm shim

Installs the compiled binary for this platform from the GitHub release that
matches the package version and verifies it against `checksums.json`.

```
npm install -g @acme-org/acme
```

Rename before publishing: `name`, `bin` keys, `repository`, `homepage` in
`package.json`; `REPO` and `BINARY_NAME` in `install.js`; `BINARY_NAME` in
`bin/launcher.js`. `version` and `checksums.json` are written by
`release/upload-binaries.sh` on every release.
