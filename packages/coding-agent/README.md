**Note**: This is a personal fork of [pi](https://github.com/earendil-works/pi-mono) at [jamwil/pi-mono](https://github.com/jamwil/pi-mono), rebased onto upstream regularly. It differs as follows:

- All telemetry and non-provider network calls (update checks, model catalog refresh) are disabled unconditionally.
- The `/share` and `/bug` commands are removed; sessions are not uploaded anywhere.
- The CLI is published as [`@jamwil/pi-coding-agent`](https://www.npmjs.com/package/@jamwil/pi-coding-agent); see PUBLISH_FORK.md in the repository root for versioning and the release process.
- The npm package includes a standalone Node build (`dist/standalone/cli.mjs`) that runs without `node_modules`.

The rest of this README is inherited from upstream.

---

<p align="center">
  <a href="https://pi.dev">
    <img alt="Pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@jamwil/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@jamwil/pi-coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

# Pi

Pi is a minimal, extensible AI agent for the terminal. Adapt Pi to your workflow, not the other way around.

Ask Pi to create the prompt templates, skills, extensions, and themes you need, or install a Pi package. Use Pi directly, automate it in print, JSON, or RPC mode, or build applications with the TypeScript SDK.

## Getting started

Install the command-line interface with npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

This requires Node.js 22.19 or newer. Pi does not require dependency lifecycle scripts for a normal npm installation.

On macOS or Linux, you can instead use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Development

Clone the repository, install its dependencies, and run Pi from source:

```bash
git clone https://github.com/earendil-works/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/earendil-works/pi/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
