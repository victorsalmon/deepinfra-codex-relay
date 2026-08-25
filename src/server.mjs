import http from "node:http";
import { buildAssistantMessage, buildFunctionCall, buildOutputTextPart, chatResponseToResponse, errorResponse, makeId, responsesRequestToChat, textOfChatDelta } from "./translate.mjs";

const HTTP_STATUS = { OK: 200, BAD_REQUEST: 400, NOT_FOUND: 404, INTERNAL_SERVER_ERROR: 500 };
const CONTENT_TYPE = { JSON: "application/json; charset=utf-8", JSON_PLAIN: "application/json", SSE: "text/event-stream" };
const SSE = { DATA_PREFIX: "data: ", DONE: "[DONE]", DELIMITER: "\n\n" };
const MAX_ERROR_BODY_PREVIEW_LENGTH = 1000;
const DEFAULT_OUTPUT_INDEX = 0;
const DEFAULT_CONTENT_INDEX = 0;

const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  model: process.env.DEEPINFRA_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
  token: process.env.DEEPINFRA_TOKEN ?? process.env.DEEPINFRA_API_KEY,
  baseUrl: process.env.DEEPINFRA_BASE_URL ?? "https://api.deepinfra.com/v1/openai/chat/completions"
};

/** Write a JSON response with the given HTTP status and close the socket. */
function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": CONTENT_TYPE.JSON });
  res.end(JSON.stringify(body));
}

/** Read the full request body and parse it as JSON, falling back to an empty object. */
async function parseRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/** Write one Server-Sent Event line to the response stream. */
function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}${SSE.DELIMITER}`);
}

/**
 * Relay a single OpenAI Responses request to DeepInfra's Chat Completions
 * endpoint and translate the response back. Non-streaming requests return a
 * single JSON response; streaming requests emit an SSE event stream.
 */
async function handleResponses(request, res) {
  // Return 500 (not 401) because the missing token is a deployment issue, not
  // a credential supplied by the caller.
  if (!config.token) return sendJson(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, errorResponse("DEEPINFRA_TOKEN is not set", "missing_credentials"));

  const chatRequest = responsesRequestToChat(request, config);
  const upstream = await fetch(config.baseUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": CONTENT_TYPE.JSON_PLAIN },
    body: JSON.stringify(chatRequest)
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    return sendJson(res, upstream.status, errorResponse(`DeepInfra request failed (${upstream.status}): ${body.slice(0, MAX_ERROR_BODY_PREVIEW_LENGTH)}`));
  }
  if (!request.stream) return sendJson(res, HTTP_STATUS.OK, chatResponseToResponse(await upstream.json(), chatRequest.model));

  res.writeHead(HTTP_STATUS.OK, { "content-type": CONTENT_TYPE.SSE, "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = makeId("resp");
  const messageId = makeId("msg");
  const outputText = [];
  const toolCalls = new Map();

  sendSse(res, "response.created", { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model, output: [], usage: null } });
  sendSse(res, "response.in_progress", { type: "response.in_progress", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model } });

  // Accumulate partial SSE lines across fetch chunks; the last (possibly
  // incomplete) line is kept in the buffer for the next chunk.
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(SSE.DATA_PREFIX)) continue;
      const raw = line.slice(SSE.DATA_PREFIX.length).trim();
      // The [DONE] sentinel is the standard OpenAI-style stream terminator.
      if (!raw || raw === SSE.DONE) continue;
      let delta;
      try { delta = JSON.parse(raw); } catch { continue; }
      const text = textOfChatDelta(delta);
      if (text) {
        outputText.push(text);
        sendSse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, delta: text });
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
          sendSse(res, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: existing.id, output_index: index, delta: call.function.arguments });
        }
        toolCalls.set(index, existing);
      }
    }
  }
  const fullText = outputText.join("");
  sendSse(res, "response.output_text.done", { type: "response.output_text.done", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, text: fullText });
  sendSse(res, "response.content_part.done", { type: "response.content_part.done", item_id: messageId, output_index: DEFAULT_OUTPUT_INDEX, content_index: DEFAULT_CONTENT_INDEX, part: buildOutputTextPart(fullText) });
  sendSse(res, "response.output_item.done", { type: "response.output_item.done", output_index: DEFAULT_OUTPUT_INDEX, item: buildAssistantMessage({ id: messageId, text: fullText }) });
  const streamedOutput = [buildAssistantMessage({ id: messageId, text: fullText })];
  for (const call of toolCalls.values()) {
    sendSse(res, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: call.id, output_index: streamedOutput.length, arguments: call.arguments });
    streamedOutput.push(buildFunctionCall({ id: call.id, name: call.name, args: call.arguments }));
  }
  sendSse(res, "response.completed", { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model: chatRequest.model, output: streamedOutput, output_text: fullText, usage: null } });
  res.write(`${SSE.DATA_PREFIX}${SSE.DONE}${SSE.DELIMITER}`);
  res.end();
}

/** Create an HTTP server that exposes /health and /v1/responses. */
export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return sendJson(res, HTTP_STATUS.OK, { ok: true, model: config.model });
      if (req.method !== "POST" || req.url !== "/v1/responses") return sendJson(res, HTTP_STATUS.NOT_FOUND, errorResponse("Use POST /v1/responses", "not_found"));
      await handleResponses(await parseRequestBody(req), res);
    } catch (error) {
      sendJson(res, HTTP_STATUS.BAD_REQUEST, errorResponse(error instanceof Error ? error.message : "Invalid request", "invalid_request"));
    }
  });
}

// Start the relay only when this file is executed directly (e.g. `node src/server.mjs`).
if (process.argv[1]?.toLowerCase().endsWith("server.mjs")) {
  if (!config.token) console.error("DEEPINFRA_TOKEN is not set; the relay will return a credential error.");
  createServer().listen(config.port, config.host, () => console.log(`DeepInfra Codex relay listening on http://${config.host}:${config.port}`));
}
