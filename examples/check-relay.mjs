// Minimal runnable example: check the relay health endpoint and send one
// sample OpenAI Responses request through it.
//
// 1. Start the relay first (runtime-only token, never committed):
//      export DEEPINFRA_TOKEN="<runtime-only-token>"
//      node src/server.mjs
// 2. In another shell: node examples/check-relay.mjs
//
// Uses only the Node.js 20+ global fetch; no dependencies.

const base = process.env.RELAY_URL ?? 'http://127.0.0.1:8787';

const health = await fetch(`${base}/health`);
console.log('health:', health.status, await health.text());

const response = await fetch(`${base}/v1/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: process.env.DEEPINFRA_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash-0731',
    input: 'Say "relay ok" and nothing else.',
  }),
});
console.log('responses:', response.status);
console.log(JSON.stringify(await response.json(), null, 2));
