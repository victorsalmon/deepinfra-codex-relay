# Agent guide for deepinfra-codex-relay

This file is a thin pointer. The full machine rules live in
[README.md](./README.md) and [CONTRIBUTING.md](./CONTRIBUTING.md).

- Keep the relay dependency-free and stdlib-only (no new dependencies or scripts).
- Keep tests offline: stub `fetch` for upstream DeepInfra calls, never hit the
  live API or use a real token (`npm test` runs the offline suite).
- Never commit a token or `.env` file; set `DEEPINFRA_TOKEN` (or its
  `DEEPINFRA_API_KEY` alias) only in the process environment.
- See `.env.example` for the full configuration list and precedence rules.
