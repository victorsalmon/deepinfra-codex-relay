# DeepInfra Codex Relay

[![CI](https://github.com/victorsalmon/deepinfra-codex-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/victorsalmon/deepinfra-codex-relay/actions/workflows/ci.yml)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Use DeepInfra-hosted chat models as if they were an OpenAI **Responses** API endpoint.
This tiny Node.js relay sits on your loopback interface and translates between the
OpenAI Responses protocol (used by tools like Codex) and DeepInfra's OpenAI-compatible
Chat Completions endpoint. No credentials are stored in the repo, no `.env` files are
committed, and the token is sent only in the upstream `Authorization` header.

## Contents

- [What it does](#what-it-does)
- [Run](#run)
- [Configuration](#configuration)
- [API](#api)
- [Check the relay](#check-the-relay)
- [Codex configuration](#codex-configuration)
- [Architecture / How it works](#architecture--how-it-works)
- [Development](#development)
- [Contributing](#contributing)

## What it does

- Accepts `POST /v1/responses` in the OpenAI Responses shape.
- Converts the request to a DeepInfra Chat Completions body (model, messages, tools,
  `max_tokens`, `temperature`, streaming, etc.).
- Streams or returns the upstream response, mapping deltas and tool calls back to
  `response.output_text.delta`, `response.function_call_arguments.delta`, and final
  `response.completed` events.
- Provides a `GET /health` endpoint for quick checks.

## Run

Node.js 20 or newer is required.

Set `DEEPINFRA_TOKEN` only in the process environment, then start the server:

```bash
export DEEPINFRA_TOKEN="<runtime-only-token>"
node src/server.mjs
```

```powershell
$env:DEEPINFRA_TOKEN = "<runtime-only-token>"
node .\src\server.mjs
```

Optional settings are listed under [Configuration](#configuration) below.

The repository contains no token, `.env` file, or credential fallback. `.env.example`
is placeholder-only and `.gitignore` excludes local secret files.

## Configuration

All settings come from the process environment (see `.env.example` for the full list):

| Variable | Required | Default |
|---|---|---|
| `DEEPINFRA_TOKEN` | Yes | — (runtime-only; never commit a real token) |
| `DEEPINFRA_MODEL` | No | `deepseek-ai/DeepSeek-V4-Flash-0731` |
| `DEEPINFRA_BASE_URL` | No | `https://api.deepinfra.com/v1/openai/chat/completions` |
| `HOST` | No | `127.0.0.1` |
| `PORT` | No | `8787` |

## API

Routes implemented in `src/server.mjs`:

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | `200` with `{ "ok": true, "model": "<configured model>" }` |
| `POST` | `/v1/responses` | `200` with a Responses-shaped JSON object, or a `text/event-stream` SSE stream when the request asks for streaming |
| any | anything else | `404` (`not_found` — "Use POST /v1/responses") |

Error cases on `POST /v1/responses`: missing `DEEPINFRA_TOKEN` returns `500`
(`missing_credentials`); an upstream DeepInfra failure is forwarded with the
upstream status code; a malformed request body returns `400`
(`invalid_request`).

## Check the relay

```bash
curl http://127.0.0.1:8787/health
```

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Codex configuration

Point a Codex provider at the local relay, not directly at DeepInfra:

```toml
[model_providers.deepinfra-relay]
name = "DeepInfra via local relay"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = false
```

Then use a profile such as:

```toml
model = "deepseek-ai/DeepSeek-V4-Flash-0731"
model_provider = "deepinfra-relay"
model_reasoning_effort = "medium"
```

The relay must be running before Codex sends a request.

## Architecture / How it works

The relay is a plain `node:http` server with two responsibilities:

1. **Translation** (`src/translate.mjs`) turns an OpenAI Responses request into a
   Chat Completions request. System `instructions` become a `system` message, the
   `input` array is mapped to `user`/`assistant`/`tool` messages, and function
   `tools` are rewritten to the Chat Completions tool format. Streaming is preserved.
2. **Proxy** (`src/server.mjs`) forwards the translated body to
   `https://api.deepinfra.com/v1/openai/chat/completions` with your token in the
   `Authorization` header. For non-streaming calls it returns a single Responses-shaped
   JSON object; for streaming calls it emits Server-Sent Events that mirror the
   OpenAI Responses streaming event vocabulary.

Because the server binds to `127.0.0.1` by default, the token and traffic never leave
your machine unless you choose to expose it.

## Development

```bash
npm test
```

```powershell
npm test
```

`npm test` runs the built-in Node.js test runner against the translation logic.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Keep the relay dependency-free and
stdlib-only, keep tests offline (stub `fetch` — never hit the live API or use
a real token), and never commit a token or `.env` file.
