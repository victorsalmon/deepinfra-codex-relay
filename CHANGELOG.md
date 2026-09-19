# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- `src/server.mjs` streaming robustness: a mid-stream upstream failure now ends
  the SSE stream with a `response.failed` event and the `[DONE]` sentinel instead
  of throwing `ERR_HTTP_HEADERS_SENT` (an unhandled rejection that could exit the
  process and leave the client hanging); `sendJson` also refuses to rewrite
  headers once a stream has started.
- `src/server.mjs` tool-call indexing: `response.function_call_arguments.delta`
  events now carry the same `output_index` as their `…done` and
  `response.completed` counterparts (the streamed assistant message reserves
  index 0, tool calls start at 1).
- `src/translate.mjs` role coverage: `developer` input messages (the Responses
  successor to `system`) are normalized to the `system` role instead of being
  silently dropped, which previously turned developer-only input into a
  `400 invalid_request`.
- `src/server.mjs` error hygiene: a malformed JSON body returns a generic
  `400 invalid_request` message; Node's parser message (which embeds a snippet of
  the caller's body) is never echoed back.
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
