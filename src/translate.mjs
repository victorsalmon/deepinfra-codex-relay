const SUPPORTED_ROLES = new Set(["system", "user", "assistant", "tool"]);
const TEXT_CONTENT_TYPES = new Set(["input_text", "output_text", "text"]);
const IMAGE_CONTENT_TYPES = new Set(["input_image", "image_url"]);
const DEFAULT_TOOL_ARGUMENTS = "{}";
const IMAGE_OMITTED = "[image: omitted]";
const IMAGE_PLACEHOLDER = "[image]";
const MS_PER_SECOND = 1000;

/** Return the current Unix timestamp in seconds. */
function nowInSeconds() {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

/**
 * Build a prefixed identifier. When a raw upstream id is supplied, reuse it
 * (e.g. `resp_${chat.id}`); otherwise generate a stripped UUID.
 */
export function makeId(prefix, rawId = undefined) {
  return rawId ? `${prefix}_${rawId}` : `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Build one `output_text` content part. */
export function buildOutputTextPart(text) {
  return { type: "output_text", text, annotations: [] };
}

/** Build the full `content` array for an assistant message. */
export function buildOutputTextContent(text) {
  return [buildOutputTextPart(text)];
}

/** Build an assistant message output item. */
export function buildAssistantMessage({ id, text }) {
  return { type: "message", id, status: "completed", role: "assistant", content: buildOutputTextContent(text) };
}

/** Build a function call output item. */
export function buildFunctionCall({ id, name, args }) {
  return { type: "function_call", id, call_id: id, name, arguments: args, status: "completed" };
}

/**
 * Flatten a Responses content value (string, array of parts, or single part)
 * into a single text string suitable for Chat Completions `content`. Image
 * parts are replaced with placeholders because this adapter does not transmit
 * image bytes to DeepInfra.
 */
function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (TEXT_CONTENT_TYPES.has(part.type)) return part.text ?? "";
    if (IMAGE_CONTENT_TYPES.has(part.type)) return part.image_url ? IMAGE_OMITTED : IMAGE_PLACEHOLDER;
    return "";
  }).filter(Boolean).join("\n");
}

/**
 * Convert a single Responses input item into a Chat Completions message.
 * Returns `null` for unsupported items so callers can skip them.
 */
function responseItemToChatMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (SUPPORTED_ROLES.has(item.role)) {
    return { role: item.role, content: textOfContent(item.content) };
  }
  if (item.type === "function_call_output") {
    return { role: "tool", tool_call_id: item.call_id ?? item.id, content: textOfContent(item.output) };
  }
  if (item.type === "function_call") {
    // Chat Completions represents a tool call as an assistant message with a
    // `tool_calls` array and `content: null`.
    return { role: "assistant", content: null, tool_calls: [{
      id: item.call_id ?? item.id,
      type: "function",
      function: { name: item.name, arguments: item.arguments ?? DEFAULT_TOOL_ARGUMENTS }
    }] };
  }
  return null;
}

/**
 * Build the Chat Completions `messages` array from a Responses `input` value
 * and optional `instructions` (which become a system message).
 */
export function responsesInputToChatMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: textOfContent(instructions) });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const message = responseItemToChatMessage(item);
      if (message) messages.push(message);
    }
  }
  return messages;
}

/**
 * Translate an OpenAI Responses request into a DeepInfra Chat Completions
 * request. Applies defaults, maps messages/tools, and preserves streaming.
 */
export function responsesRequestToChat(request, defaults = {}) {
  const body = {
    model: request.model ?? defaults.model,
    messages: responsesInputToChatMessages(request.input, request.instructions),
    stream: Boolean(request.stream)
  };
  if (!body.model) throw new Error("model is required");
  if (request.max_output_tokens != null) body.max_tokens = request.max_output_tokens;
  for (const key of ["temperature", "top_p", "tool_choice", "parallel_tool_calls", "response_format", "user"]) {
    if (request[key] !== undefined) body[key] = request[key];
  }
  if (request.tools !== undefined) {
    body.tools = request.tools
      .filter((tool) => tool.type === "function")
      .map((tool) => tool.function === undefined
        ? { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
        : tool);
    if (body.tools.length === 0) delete body.tools;
  }
  if (request.reasoning?.effort) body.reasoning_effort = request.reasoning.effort;
  return body;
}

/** Map DeepInfra token-usage field names to the Responses API shape. */
function usageOf(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

/**
 * Build the `output` array for a Responses response from a single Chat
 * Completions choice (one assistant message plus any tool calls).
 */
function outputFromChoice(choice) {
  const message = choice?.message ?? {};
  const output = [];
  const text = textOfContent(message.content);
  if (text) output.push(buildAssistantMessage({ id: makeId("msg"), text }));
  for (const call of message.tool_calls ?? []) {
    output.push(buildFunctionCall({
      id: call.id,
      name: call.function?.name ?? "",
      args: call.function?.arguments ?? DEFAULT_TOOL_ARGUMENTS
    }));
  }
  return output;
}

/**
 * Convert a full DeepInfra Chat Completions response into an OpenAI Responses
 * response. Falls back to a generated id and the current Unix time when the
 * upstream payload omits them.
 */
export function chatResponseToResponse(chat, requestedModel) {
  const choice = chat.choices?.[0] ?? {};
  const output = outputFromChoice(choice);
  const text = output.find((item) => item.type === "message")?.content?.[0]?.text ?? "";
  return {
    id: makeId("resp", chat.id),
    object: "response",
    created_at: chat.created ?? nowInSeconds(),
    status: "completed",
    completed_at: chat.created ?? nowInSeconds(),
    error: null,
    incomplete_details: null,
    model: chat.model ?? requestedModel,
    output,
    output_text: text,
    usage: usageOf(chat.usage),
    metadata: {}
  };
}

/** Build a standard Responses-style error envelope. */
export function errorResponse(message, code = "upstream_error") {
  return { error: { message, type: "invalid_request_error", code } };
}

/** Extract the text delta from a Chat Completions streaming chunk. */
export function textOfChatDelta(delta) {
  return textOfContent(delta?.choices?.[0]?.delta?.content);
}
