const SUPPORTED_ROLES = new Set(["system", "user", "assistant", "tool"]);
const TEXT_CONTENT_TYPES = new Set(["input_text", "output_text", "text"]);
const IMAGE_CONTENT_TYPES = new Set(["input_image", "image_url"]);
const DEFAULT_TOOL_ARGUMENTS = "{}";
const IMAGE_OMITTED = "[image: omitted]";
const IMAGE_PLACEHOLDER = "[image]";
const MS_PER_SECOND = 1000;

function nowInSeconds() {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

export function makeId(prefix, rawId = undefined) {
  return rawId ? `${prefix}_${rawId}` : `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

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

function responseItemToChatMessage(item) {
  if (!item || typeof item !== "object") return null;
  if (SUPPORTED_ROLES.has(item.role)) {
    return { role: item.role, content: textOfContent(item.content) };
  }
  if (item.type === "function_call_output") {
    return { role: "tool", tool_call_id: item.call_id ?? item.id, content: textOfContent(item.output) };
  }
  if (item.type === "function_call") {
    return { role: "assistant", content: null, tool_calls: [{
      id: item.call_id ?? item.id,
      type: "function",
      function: { name: item.name, arguments: item.arguments ?? DEFAULT_TOOL_ARGUMENTS }
    }] };
  }
  return null;
}

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

function usageOf(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function outputFromChoice(choice) {
  const message = choice?.message ?? {};
  const output = [];
  const text = textOfContent(message.content);
  if (text) output.push({
    type: "message",
    id: makeId("msg"),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }]
  });
  for (const call of message.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? DEFAULT_TOOL_ARGUMENTS,
      status: "completed"
    });
  }
  return output;
}

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

export function errorResponse(message, code = "upstream_error") {
  return { error: { message, type: "invalid_request_error", code } };
}

export function textOfChatDelta(delta) {
  return textOfContent(delta?.choices?.[0]?.delta?.content);
}
