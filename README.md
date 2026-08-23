# DeepInfra Codex Relay

Local protocol adapter for using DeepInfra Chat Completions models from clients
that speak the OpenAI Responses API, including Codex.

The relay listens on loopback only and forwards `POST /v1/responses` to
DeepInfra's OpenAI-compatible Chat Completions endpoint. It supports normal and
server-sent-event streaming, system instructions, text input, function tools,
and tool results. It is intentionally not a public network service.

## Run

Node.js 20 or newer is required.

Set `DEEPINFRA_TOKEN` only in the process environment, then start the server:

```powershell
$env:DEEPINFRA_TOKEN = "<runtime-only-token>"
node .\src\server.mjs
```

For the configured AWS secret, use the included wrapper. It injects the
`DEEPINFRA_TOKEN` field into the child process without printing or writing the
secret:

```powershell
.\scripts\start-with-aws.ps1
```

The repository contains no token, `.env` file, AWS profile contents, or
credential fallback. `.env.example` is placeholder-only and `.gitignore`
excludes local secret files.

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

The relay must be running before Codex sends a request. Check it with:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

## Development

```powershell
npm test
```

DeepInfra remains the credential boundary: the token is sent only in the
upstream `Authorization` header and is never logged by this project.
