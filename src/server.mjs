import http from "node:http";
import { chatResponseToResponse, errorResponse, responsesRequestToChat, textOfChatDelta } from "./translate.mjs";

const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  model: process.env.DEEPINFRA_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731",
  token: process.env.DEEPINFRA_TOKEN ?? process.env.DEEPINFRA_API_KEY,
  baseUrl: process.env.DEEPINFRA_BASE_URL ?? "https://api.deepinfra.com/v1/openai/chat/completions"
};

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function parseRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleResponses(request, res) {
  if (!config.token) return sendJson(res, 500, errorResponse("DEEPINFRA_TOKEN is not set", "missing_credentials"));
  const chatRequest = responsesRequestToChat(request, config);
  const upstream = await fetch(config.baseUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(chatRequest)
  });
  if (!upstream.ok) {
    const body = await upstream.text();
    return sendJson(res, upstream.status, errorResponse(`DeepInfra request failed (${upstream.status}): ${body.slice(0, 1000)}`));
  }
  if (!request.stream) return sendJson(res, 200, chatResponseToResponse(await upstream.json(), chatRequest.model));

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const messageId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  const outputText = [];
  const toolCalls = new Map();
  sendSse(res, "response.created", { type: "response.created", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model, output: [], usage: null } });
  sendSse(res, "response.in_progress", { type: "response.in_progress", response: { id: responseId, object: "response", status: "in_progress", model: chatRequest.model } });
  let buffer = "";
  for await (const chunk of upstream.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      let delta;
      try { delta = JSON.parse(raw); } catch { continue; }
      const text = textOfChatDelta(delta);
      if (text) {
        outputText.push(text);
        sendSse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta: text });
      }
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
  sendSse(res, "response.output_text.done", { type: "response.output_text.done", item_id: messageId, output_index: 0, content_index: 0, text: fullText });
  sendSse(res, "response.content_part.done", { type: "response.content_part.done", item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: fullText, annotations: [] } });
  sendSse(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }] } });
  const streamedOutput = [{ type: "message", id: messageId, status: "completed", role: "assistant", content: [{ type: "output_text", text: fullText, annotations: [] }] }];
  for (const call of toolCalls.values()) {
    sendSse(res, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: call.id, output_index: streamedOutput.length, arguments: call.arguments });
    streamedOutput.push({ type: "function_call", id: call.id, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" });
  }
  sendSse(res, "response.completed", { type: "response.completed", response: { id: responseId, object: "response", status: "completed", model: chatRequest.model, output: streamedOutput, output_text: fullText, usage: null } });
  res.write("data: [DONE]\n\n");
  res.end();
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return sendJson(res, 200, { ok: true, model: config.model });
      if (req.method !== "POST" || req.url !== "/v1/responses") return sendJson(res, 404, errorResponse("Use POST /v1/responses", "not_found"));
      await handleResponses(await parseRequestBody(req), res);
    } catch (error) {
      sendJson(res, 400, errorResponse(error instanceof Error ? error.message : "Invalid request", "invalid_request"));
    }
  });
}

if (process.argv[1]?.toLowerCase().endsWith("server.mjs")) {
  if (!config.token) console.error("DEEPINFRA_TOKEN is not set; the relay will return a credential error.");
  createServer().listen(config.port, config.host, () => console.log(`DeepInfra Codex relay listening on http://${config.host}:${config.port}`));
}
