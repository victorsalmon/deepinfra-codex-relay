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

test("maps a Chat Completions response to a Responses response", () => {
  const result = chatResponseToResponse({ id: "chat-1", model: "deepseek", created: 123, choices: [{ message: { role: "assistant", content: "Hi" } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, "fallback");
  assert.equal(result.object, "response");
  assert.equal(result.output_text, "Hi");
  assert.equal(result.output[0].content[0].type, "output_text");
  assert.deepEqual(result.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
});
