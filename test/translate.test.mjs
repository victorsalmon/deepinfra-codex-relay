import test from "node:test";
import assert from "node:assert/strict";
import { chatResponseToResponse, responsesRequestToChat } from "../src/translate.mjs";

test("translates Responses input, instructions, and function tools to Chat Completions", () => {
  const result = responsesRequestToChat({
    model: "deepseek-ai/DeepSeek-V4-Flash-0731",
    instructions: "Be concise.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
    max_output_tokens: 80,
    stream: true,
    tools: [
      { type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object" } },
      { type: "web_search_preview" }
    ]
  });
  assert.deepEqual(result.messages, [{ role: "system", content: "Be concise." }, { role: "user", content: "Hello" }]);
  assert.equal(result.max_tokens, 80);
  assert.equal(result.stream, true);
  assert.equal(result.tools[0].type, "function");
  assert.equal(result.tools[0].function.name, "lookup");
});

test("rejects malformed tools, reasoning.effort, and input shapes with TypeError", () => {
  assert.throws(() => responsesRequestToChat({ model: "m", input: "hi", tools: { type: "function" } }), (error) => error instanceof TypeError && /tools/.test(error.message));
  assert.throws(() => responsesRequestToChat({ model: "m", input: "hi", reasoning: { effort: 42 } }), (error) => error instanceof TypeError && /reasoning\.effort/.test(error.message));
  assert.throws(() => responsesRequestToChat({ model: "m", input: 42 }), (error) => error instanceof TypeError && /input/.test(error.message));
  assert.throws(() => responsesRequestToChat({ model: "m", input: { role: "user" } }), (error) => error instanceof TypeError && /input/.test(error.message));
});

test("maps function tools: filters non-functions, requires name, defaults parameters", () => {
  const result = responsesRequestToChat({
    model: "m",
    input: "hi",
    tools: [
      { type: "web_search_preview" },
      { type: "function", name: "lookup", description: "Look up a value" }
    ]
  });
  assert.equal(result.tools.length, 1);
  assert.deepEqual(result.tools[0].function.parameters, { type: "object" });
  const explicit = responsesRequestToChat({
    model: "m",
    input: "hi",
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }]
  });
  assert.deepEqual(explicit.tools[0].function.parameters, { type: "object", properties: { q: { type: "string" } } });
  assert.throws(() => responsesRequestToChat({ model: "m", input: "hi", tools: [{ type: "function", description: "no name" }] }), (error) => error instanceof TypeError && /tools\[0\].*name/.test(error.message));
});

test("round-trips assistant tool_call through chat messages to Responses output", () => {
  const chatRequest = responsesRequestToChat({
    model: "m",
    input: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"x\"}" }]
  });
  assert.equal(chatRequest.messages.length, 1);
  assert.equal(chatRequest.messages[0].role, "assistant");
  assert.equal(chatRequest.messages[0].tool_calls[0].id, "call_1");
  assert.equal(chatRequest.messages[0].tool_calls[0].function.name, "lookup");
  const response = chatResponseToResponse({
    id: "chat-1",
    model: "m",
    created: 123,
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  }, "m");
  const call = response.output.find((item) => item.type === "function_call");
  assert.equal(call.call_id, "call_1");
  assert.equal(call.name, "lookup");
  assert.equal(call.arguments, "{\"q\":\"x\"}");
});
test("maps a Chat Completions response to a Responses response", () => {
  const result = chatResponseToResponse({ id: "chat-1", model: "deepseek", created: 123, choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, "fallback");
  assert.equal(result.object, "response");
  assert.equal(result.output_text, "Hi");
  assert.equal(result.output[0].content[0].type, "output_text");
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
});
