# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- `src/translate.mjs` validation tightening: `responsesRequestToChat` now
  throws `TypeError` (mapped to 400 by the server) when `tools` is neither an
  array nor undefined, when `reasoning.effort` is present but not a string, or
  when `input` is neither a string, an array, nor undefined; function tools
  missing `name` throw naming the index and absent `parameters` defaults to
  `{ type: "object" }`.
- Documented contracts: image parts are never transmitted (placeholders
  `[image]` / `[image: omitted]`); streaming responses report `usage: null`
  while non-streaming maps prompt/completion/total tokens.

- Public-profile grooming: `SECURITY.md`, `CONTRIBUTING.md`, a runnable relay
  example, a `files` allow-list, and author identity normalized to
  Victor Salmon.

## [0.1.0]

- Initial public release: local OpenAI Responses relay for DeepInfra Chat
  Completions with health check and streaming support.
