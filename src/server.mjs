import http from "node:http";
import crypto from "node:crypto";
import { buildAssistantMessage, buildFunctionCall, buildOutputTextPart, chatResponseToResponse, errorResponse, makeId, responsesRequestToChat, textOfChatDelta } from "./translate.mjs";

const HTTP_STATUS = { OK: 200, BAD_REQUEST: 400, UNAUTHORIZED: 401, NOT_FOUND: 404, PAYLOAD_TOO_LARGE: 413, INTERNAL_SERVER_ERROR: 500 };
const CONTENT_TYPE = { JSON: "application/json; charset=utf-8", JSON_PLAIN: "application/json", SSE: "text/event-stream" };
const SSE = { DATA_PREFIX: "data: ", DONE: "[DONE]", DELIMITER: "\n\n" };
const MAX_ERROR_BODY_PREVIEW_LENGTH = 1000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_SSE_LINE_BYTES = 256 * 1024;
const DEFAULT_OUTPUT_INDEX = 0;
const DEFAULT_CONTENT_INDEX = 0;

/** Maximum POST body size in bytes (configurable via MAX_BODY_BYTES, default 1 MiB). */
export function getMaxBodyBytes() {
  const raw = process.env.MAX_BODY_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_BODY_BYTES;
  return Math.floor(parsed);
}

/** Optional caller token; empty string means auth is disabled (loopback default). */
export function getRelayToken() {
  return process.env.RELAY_TOKEN ?? "";
}

/** Resolve the live server configuration from the process environment. */
export function getConfig() {
  return {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 8787),
    model: process.env.DEEPINFRA_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
    token: process.env.DEEPINFRA_TOKEN ?? process.env.DEEPINFRA_API_KEY,
    baseUrl: process.env.DEEPINFRA_BASE_URL ?? "https://api.deepinfra.com/v1/openai/chat/completions",
    relayToken: getRelayToken(),
    maxBodyBytes: getMaxBodyBytes()
  };
}

// Backwards-compatible snapshot for direct property access; prefer getConfig()
// inside request handling so tests can vary the environment per case.
export const config = getConfig();

/** True for loopback-only bind addresses. */
export function isLoopbackHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost" || normalized === "::ffff:127.0.0.1";
}

/** Startup warnings for unauthenticated operation (no secrets included). */
export function getStartupWarnings(cfg = getConfig()) {
  const warnings = [];
  if (!cfg.relayToken) {
    warnings.push("RELAY_TOKEN is not set; POST /v1/responses is unauthenticated.");
  }
  if (!isLoopbackHost(cfg.host) && !cfg.relayToken) {
    warnings.push(`HOST=${cfg.host} is non-loopback and RELAY_TOKEN is not set; the relay is unauthenticated and DeepInfra quota is exposed. Bind to loopback or set RELAY_TOKEN.`);
  }
  return warnings;
}

/** Timing-safe caller-auth check for POST /v1/responses. */
export function isAuthorized(req, relayToken) {
  if (!relayToken) return true;
  const header = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const provided = header.slice(prefix.length);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(relayToken, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Write a JSON response with the given HTTP status and close the socket. */
function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": CONTENT_TYPE.JSON });
  res.end(JSON.stringify(body));
}

/**
 * Read the request body up to maxBytes and parse it as JSON.
 * Rejects oversized Content-Length without reading, and aborts buffering
 * as soon as the cap is exceeded. Throws an Error with statusCode 413 on
 * over-limit bodies.
 */
export async function parseRequestBody(req, maxBytes = getMaxBodyBytes()) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`Request body too large (declared ${declared} bytes, limit ${maxBytes} bytes)`);
    error.statusCode = HTTP_STATUS.PAYLOAD_TOO_LARGE;
    throw error;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const size = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    total += size;
    if (total > maxBytes) {
      const error = new Error(`Request body too large (limit ${maxBytes} bytes)`);
      error.statusCode = HTTP_STATUS.PAYLOAD_TOO_LARGE;
      throw error;
    }
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Write one SSE line, awaiting drain so a slow client bounds memory. */
async function sendSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}${SSE.DELIMITER}`;
  if (!res.write(line)) {
    await new Promise((resolve) => {
      const done = () => {
        res.off("error", done);
        resolve();
      };
      res.once("drain", done);
      res.once("error", done);
      res.once("close", done);
    });
  }
}

/**
 * Truncate an upstream error preview and redact the operator token if it
 * ever appears inside the body. Never includes request bodies or headers.
 */
export function sanitizeUpstreamPreview(body, token) {
  let preview = String(body ?? "").slice(0, MAX_ERROR_BODY_PREVIEW_LENGTH);
  if (token && preview.includes(token)) {
    preview = preview.split(token).join("[redacted]");
  }
  return preview;
}

/**
 * Relay a single OpenAI Responses request to DeepInfra's Chat Completions
 * endpoint and translate the response back. Non-streaming requests return a
 * single JSON response; streaming requests emit an SSE event stream.
 */
async function handleResponses(request, res, { signal, cfg } = {}) {
  const active = cfg ?? getConfig();
  // Return 500 (not 401) because the missing token is a deployment issue, not
  // a credential supplied by the caller.
  if (!active.token) return sendJson(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, errorResponse("DEEPINFRA_TOKEN is not set", "missing_credentials"));

  let chatRequest;
  try {
    chatRequest = responsesRequestToChat(request, active);
  } catch (error) {
    return sendJson(res, HTTP_STATUS.BAD_REQUEST, errorResponse(error instanceof Error ? error.message : "Invalid request", "invalid_request"));
  }
  if (!Array.isArray(chatRequest.messages) || chatRequest.messages.length === 0) {
    return sendJson(res, HTTP_STATUS.BAD_REQUEST, errorResponse("Request translates to zero chat messages; provide input or instructions", "invalid_request"));
  }

  let upstream;
  try {
    upstream = await fetch(active.baseUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${active.token}`, "content-type": CONTENT_TYPE.JSON_PLAIN },
      body: JSON.stringify(chatRequest),
      signal
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return;
    return sendJson(res, HTTP_STATUS.BAD_REQUEST, errorResponse("Upstream request failed", "upstream_error"));
  }
  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    const preview = sanitizeUpstreamPreview(body, active.token);
    return sendJson(res, upstream.status, errorResponse(`DeepInfra request failed (${upstream.status}): ${preview}`));
  }
  if (!request.stream) return sendJson(res, HTTP_STATUS.OK, chatResponseToResponse(await upstream.json(), chatRequest.model));

  res.writeHead(HTTP_STATUS.OK, { "content-type": CONTENT_TYPE.SSE, "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = makeId("resp");
  const messageId = makeId("msg");
  const outputText = [];
  const toolCalls = new Map();

  await sendSse(res, "response.created", { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model, output: [], usage: null } });
  await sendSse(res, "response.in_progress", { type: "response.in_progress", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model } });

  // Accumulate partial SSE lines across fetch chunks; the last (possibly
  // incomplete) line is kept in the buffer for the next chunk. The buffer is
  // bounded so a line without a terminator cannot grow without limit.
  let buffer = "";
  let aborted = false;
  try {
    for await (const chunk of upstream.body) {
      if (signal?.aborted || res.writableEnded || res.destroyed) {
        aborted = true;
        break;
      }
      buffer += Buffer.from(chunk).toString("utf8");
      if (buffer.length > MAX_SSE_LINE_BYTES) {
        // Drop the over-long pending line rather than buffering forever.
        const newline = buffer.indexOf("\n");
        buffer = newline === -1 ? "" : buffer.slice(newline + 1);
        if (buffer.length > MAX_SSE_LINE_BYTES) buffer = "";
        continue;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (signal?.aborted || res.writableEnded || res.destroyed) {
          aborted = true;
          break;
        }
        if (!line.startsWith(SSE.DATA_PREFIX)) continue;
        const raw = line.slice(SSE.DATA_PREFIX.length).trim();
        // The [DONE] sentinel is the standard OpenAI-style stream terminator.
        if (!raw || raw === SSE.DONE) continue;
        let delta;
        try { delta = JSON.parse(raw); } catch { continue; }
        const text = textOfChatDelta(delta);
        if (text) {
          outputText.push(text);
          await sendSse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, delta: text });
        }
        // Accumulate tool-call fragments by index so deltas for the same call
        // are stitched back together before we emit the completed call.
        for (const call of delta.choices?.[0]?.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? { id: call.id ?? `call_${index}`, name: "", arguments: "" };
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name += call.function.name;
          if (call.function?.arguments) {
            existing.arguments += call.function.arguments;
            await sendSse(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: existing.id, output_index: index, delta: call.function.arguments });
          }
          toolCalls.set(index, existing);
        }
      }
      if (aborted) break;
    }
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") return;
    throw error;
  }
  if (aborted || signal?.aborted || res.writableEnded || res.destroyed) return;
  const fullText = outputText.join("");
  await sendSse(res, "response.output_text.done", { type: "response.output_text.done", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, text: fullText });
  await sendSse(res, "response.content_part.done", { type: "response.content_part.done", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, part: buildOutputTextPart(fullText) });
  await sendSse(res, "response.output_item.done", { type: "response.output_item.done", output_index: DEFAULT_OUTPUT_INDEX, item: buildAssistantMessage({ id: messageId, text: fullText }) });
  const streamedOutput = [buildAssistantMessage({ id: messageId, text: fullText })];
  for (const call of toolCalls.values()) {
    await sendSse(res, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: call.id, output_index: streamedOutput.length, arguments: call.arguments });
    streamedOutput.push(buildFunctionCall({ id: call.id, name: call.name, args: call.arguments }));
  }
  await sendSse(res, "response.completed", { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model: chatRequest.model, output: streamedOutput, output_text: fullText, usage: null } });
  if (!res.writableEnded && !res.destroyed) {
    res.write(`${SSE.DATA_PREFIX}${SSE.DONE}${SSE.DELIMITER}`);
    res.end();
  }
}

/** Create an HTTP server that exposes /health and /v1/responses. */
export function createServer() {
  return http.createServer(async (req, res) => {
    const cfg = getConfig();
    const controller = new AbortController();
    const abortUpstream = () => {
      // req/res 'close' also fires on normal completion (req.destroyed is
      // true for any closed stream), so gate on the socket: only abort when
      // the client actually went away. Otherwise every authorized POST
      // would hang with no response.
      if (!controller.signal.aborted && req.socket?.destroyed) {
        controller.abort();
      }
    };
    req.on("close", abortUpstream);
    res.on("close", abortUpstream);
    try {
      if (req.method === "GET" && req.url === "/health") return sendJson(res, HTTP_STATUS.OK, { ok: true, model: cfg.model });
      if (req.method !== "POST" || req.url !== "/v1/responses") return sendJson(res, HTTP_STATUS.NOT_FOUND, errorResponse("Use POST /v1/responses", "not_found"));
      if (!isAuthorized(req, cfg.relayToken)) {
        return sendJson(res, HTTP_STATUS.UNAUTHORIZED, errorResponse("Caller authorization required", "invalid_request"));
      }
      let body;
      try {
        body = await parseRequestBody(req, cfg.maxBodyBytes);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error?.statusCode === HTTP_STATUS.PAYLOAD_TOO_LARGE) {
          return sendJson(res, HTTP_STATUS.PAYLOAD_TOO_LARGE, errorResponse(error.message, "invalid_request"));
        }
        throw error;
      }
      if (controller.signal.aborted) return;
      await handleResponses(body, res, { signal: controller.signal, cfg });
    } catch (error) {
      if (controller.signal.aborted) return;
      // Never echo credentials or request bodies; only the parse/validation message.
      sendJson(res, HTTP_STATUS.BAD_REQUEST, errorResponse(error instanceof Error ? error.message : "Invalid request", "invalid_request"));
    } finally {
      req.off("close", abortUpstream);
      res.off("close", abortUpstream);
    }
  });
}

// Start the relay only when this file is executed directly (e.g. `node src/server.mjs`).
if (process.argv[1]?.toLowerCase().endsWith("server.mjs")) {
  const live = getConfig();
  if (!live.token) console.error("DEEPINFRA_TOKEN is not set; the relay will return a credential error.");
  if (!live.relayToken) console.error("RELAY_TOKEN is not set; POST /v1/responses is unauthenticated.");
  for (const warning of getStartupWarnings(live)) {
    if (warning.startsWith("RELAY_TOKEN is not set; POST") && !live.relayToken) continue; // already logged above
    console.error(warning);
  }
  createServer().listen(live.port, live.host, () => console.log(`DeepInfra Codex relay listening on http://${live.host}:${live.port}`));
}
