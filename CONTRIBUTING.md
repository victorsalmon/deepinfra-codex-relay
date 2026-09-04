# Contributing to deepinfra-codex-relay

Thanks for helping improve the relay. Changes should keep it small,
dependency-free, and credential-safe.

## Setup

- Use Node.js 20 or newer (see `.nvmrc`).
- No install or build step — the relay is dependency-free stdlib Node.
- Copy nothing: set runtime-only values in the process environment
  (see `.env.example`). Never commit a real token.

## Tests

- Run the suite: `npm test` (`node --test`).
- Keep tests offline — stub `fetch` for upstream DeepInfra calls, never hit
  the live API or use a real token.

## Pull-request conventions

- Keep a PR to one concern. Protocol translation, error handling, and docs
  should be separate PRs.
- Do not log tokens, request bodies containing secrets, or upstream error
  bodies verbatim.
- Add a `CHANGELOG.md` entry under `[Unreleased]`.
- By contributing, you agree your contributions will be licensed under the
  [MIT license](./LICENSE).
