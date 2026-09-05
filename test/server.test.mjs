import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getStartupWarnings, isLoopbackHost, createServer } from "../src/server.mjs";

// Offline server tests: upstream fetch is always stubbed, never live network,
// never a real token. Local client requests use node:http so the fetch stub
// cannot intercept them.

const STUB_TOKEN = "test-operator-token";

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

function upstreamJson(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload))
  };
}

function upstreamText(text, { status = 500 } = {}) {
  return {
    ok: false,
    status,
    json: async () => { throw new Error("no json"); },
    text: async () => text
  };
}

function sseUpstream(chunks) {
  async function* body() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }
  return { ok: true, status: 200, body: body(), json: async () => ({}), text: async () => "" };
}

async function withServer(t, env, fn) {
  const saved = {};
  for (const key of ["DEEPINFRA_TOKEN", "RELAY_TOKEN", "MAX_BODY_BYTES", "DEEPINFRA_MODEL"]) {
    saved[key] = process.env[key];
  }
  process.env.DEEPINFRA_TOKEN = env.token ?? STUB_TOKEN;
  if (env.relayToken === undefined || env.relayToken === null) delete process.env.RELAY_TOKEN;
  else process.env.RELAY_TOKEN = env.relayToken;
  if (env.maxBody === undefined || env.maxBody === null) delete process.env.MAX_BODY_BYTES;
  else process.env.MAX_BODY_BYTES = String(env.maxBody);
  if (env.unsetToken) delete process.env.DEEPINFRA_TOKEN;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => {
    // closeAllConnections first: keep-alive client sockets (and any
    // still-open SSE streams) otherwise keep server.close() pending forever.
    server.closeAllConnections();
    server.close(resolve);
  }));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return fn(port);
}

function post(port, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(payload !== null ? { "content-length": Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

const VALID_BODY = { model: "deepseek-ai/DeepSeek-V4-Flash-0731", input: "Say relay ok" };

test("health stays unauthenticated when RELAY_TOKEN is set", async (t) => {
  await withServer(t, { relayToken: "caller-secret" }, async (port) => {
    const res = await get(port, "/health");
    assert.equal(res.status, 200);
    assert.match(res.text, /"ok":true/);
  });
});

test("auth deny without token, allow with Bearer token", async (t) => {
  await withServer(t, { relayToken: "caller-secret" }, async (port) => {
    const restore = stubFetch(async () => upstreamJson({ choices: [{ message: { content: "Hi" } }] }));
    try {
      const denied = await post(port, "/v1/responses", { body: VALID_BODY });
      assert.equal(denied.status, 401);
      assert.match(denied.text, /invalid_request/);

      const wrong = await post(port, "/v1/responses", {
        headers: { authorization: "Bearer wrong" },
        body: VALID_BODY
      });
      assert.equal(wrong.status, 401);

      const allowed = await post(port, "/v1/responses", {
        headers: { authorization: "Bearer caller-secret" },
        body: VALID_BODY
      });
      assert.equal(allowed.status, 200);
      assert.match(allowed.text, /"object":"response"/);
    } finally {
      restore();
    }
  });
});

test("no RELAY_TOKEN keeps existing behavior (no auth gate)", async (t) => {
  await withServer(t, { relayToken: null }, async (port) => {
    const restore = stubFetch(async () => upstreamJson({ choices: [{ message: { content: "Hi" } }] }));
    try {
      const res = await post(port, "/v1/responses", { body: VALID_BODY });
      assert.equal(res.status, 200);
    } finally {
      restore();
    }
  });
});

test("oversize body is rejected with 413 (declared and streamed)", async (t) => {
  await withServer(t, { relayToken: null, maxBody: 64 }, async (port) => {
    const restore = stubFetch(async () => {
      throw new Error("upstream must not be called for oversize bodies");
    });
    try {
      const big = await post(port, "/v1/responses", {
        body: { model: "m", input: "x".repeat(1024) }
      });
      assert.equal(big.status, 413);

      // Chunked upload without content-length still aborts once the cap is hit.
      const streamed = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1", port, path: "/v1/responses", method: "POST",
          headers: { "content-type": "application/json" }
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.write('{"model":"m","input":"');
        req.write("y".repeat(1024));
        req.write('"}');
        req.end();
      });
      assert.equal(streamed.status, 413);
    } finally {
      restore();
    }
  });
});

test("configurable MAX_BODY_BYTES override is honored", async (t) => {
  await withServer(t, { relayToken: null, maxBody: 1024 * 1024 }, async (port) => {
    const restore = stubFetch(async () => upstreamJson({ choices: [{ message: { content: "Hi" } }] }));
    try {
      const res = await post(port, "/v1/responses", {
        body: { model: "m", input: "z".repeat(2048) }
      });
      assert.equal(res.status, 200);
    } finally {
      restore();
    }
  });
});

test("empty-message input is rejected with 400 without calling upstream", async (t) => {
  await withServer(t, { relayToken: null }, async (port) => {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls += 1;
      return upstreamJson({});
    });
    try {
      const res = await post(port, "/v1/responses", { body: { model: "m", input: [] } });
      assert.equal(res.status, 400);
      assert.match(res.text, /invalid_request/);
      assert.equal(calls, 0);
    } finally {
      restore();
    }
  });
});

test("missing DEEPINFRA_TOKEN returns 500 missing_credentials", async (t) => {
  await withServer(t, { relayToken: null, unsetToken: true }, async (port) => {
    const restore = stubFetch(async () => {
      throw new Error("upstream must not be called without a token");
    });
    try {
      const res = await post(port, "/v1/responses", { body: VALID_BODY });
      assert.equal(res.status, 500);
      assert.match(res.text, /missing_credentials/);
    } finally {
      restore();
    }
  });
});

test("upstream failure maps status with truncated preview and no token leak", async (t) => {
  await withServer(t, { relayToken: null }, async (port) => {
    const secret = process.env.DEEPINFRA_TOKEN;
    const restore = stubFetch(async () => upstreamText(`boom ${secret} ` + "E".repeat(5000), { status: 502 }));
    try {
      const res = await post(port, "/v1/responses", { body: VALID_BODY });
      assert.equal(res.status, 502);
      assert.doesNotMatch(res.text, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const parsed = JSON.parse(res.text);
      assert.ok(parsed.error.message.length <= `DeepInfra request failed (502): `.length + 1000);
    } finally {
      restore();
    }
  });
});

test("streaming contract emits the Responses SSE event sequence", async (t) => {
  await withServer(t, { relayToken: null }, async (port) => {
    const restore = stubFetch(async () => sseUpstream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n"
    ]));
    try {
      const events = await new Promise((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1", port, path: "/v1/responses", method: "POST",
          headers: { "content-type": "application/json" }
        }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
        });
        req.on("error", reject);
        req.write(JSON.stringify({ ...VALID_BODY, stream: true }));
        req.end();
      });
      assert.equal(events.status, 200);
      for (const name of ["response.created", "response.in_progress", "response.output_text.delta", "response.completed"]) {
        assert.ok(events.text.includes(`event: ${name}`), `missing ${name}`);
      }
      assert.ok(events.text.includes("data: [DONE]"));
    } finally {
      restore();
    }
  });
});

test("client close aborts the upstream fetch", async (t) => {
  await withServer(t, { relayToken: null }, async (port) => {
    let observedSignal = null;
    let abortFired = false;
    const restore = stubFetch((url, opts = {}) => {
      observedSignal = opts.signal ?? null;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(upstreamJson({})), 5000);
        observedSignal?.addEventListener("abort", () => {
          abortFired = true;
          clearTimeout(timer);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    try {
      await new Promise((resolve) => {
        const req = http.request({
          host: "127.0.0.1", port, path: "/v1/responses", method: "POST",
          headers: { "content-type": "application/json" }
        }, (res) => {
          res.on("data", () => {
            clearTimeout(killer);
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => resolve());
        // The stubbed upstream never yields a chunk until aborted, so no
        // data event can trigger the destroy — force the client close.
        const killer = setTimeout(() => req.destroy(), 500);
        req.write(JSON.stringify({ ...VALID_BODY, stream: true }));
        req.end();
        setTimeout(() => { clearTimeout(killer); resolve(); }, 2000);
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(observedSignal, "upstream fetch did not receive an abort signal");
      assert.equal(abortFired, true);
    } finally {
      restore();
    }
  });
});

test("startup warnings cover missing token and non-loopback exposure", () => {
  assert.ok(getStartupWarnings({ host: "127.0.0.1", relayToken: "" }).some((w) => w.includes("RELAY_TOKEN")));
  const exposed = getStartupWarnings({ host: "0.0.0.0", relayToken: "" });
  assert.ok(exposed.some((w) => w.includes("unauthenticated") && w.includes("quota")));
  assert.equal(getStartupWarnings({ host: "0.0.0.0", relayToken: "s" }).length, 0);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
});
