# @codecast/cli

Codecast is where your team sees, steers, and remembers every coding agent session — any agent, any machine.

This package installs the `codecast` and `cast` commands. It downloads the compiled binary for your platform from the matching [GitHub release](https://github.com/codecast-sh/codecast/releases) and verifies its SHA-256 checksum.

## Install

```sh
npm install -g @codecast/cli
```

Other channels install the same binary:

```sh
curl -fsSL codecast.sh/install | sh      # recommended
brew install codecast-sh/tap/codecast    # Homebrew
```

## Get started

```sh
cast login
cast sync
```

Docs: https://codecast.sh/documentation
