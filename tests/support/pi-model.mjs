import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export const TEST_MODEL = {
  provider: "openai",
  id: "chat-latest",
  name: "codepunk test model",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 2_000,
  maxTokens: 200,
};

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function assistantMessage(model, content, stopReason, errorMessage) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

export function textStream(model, text) {
  const stream = createAssistantMessageEventStream();
  const completed = assistantMessage(model, [{ type: "text", text }], "stop");
  stream.push({
    type: "start",
    partial: assistantMessage(model, [], "pending"),
  });
  stream.push({
    type: "text_start",
    contentIndex: 0,
    partial: assistantMessage(model, [], "pending"),
  });
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: text,
    partial: completed,
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: text,
    partial: completed,
  });
  stream.push({ type: "done", reason: "stop", message: completed });
  return stream;
}

export function toolCallStream(model, id, name, args) {
  const stream = createAssistantMessageEventStream();
  const toolCall = {
    type: "toolCall",
    id,
    name,
    arguments: args,
  };
  const pending = assistantMessage(model, [toolCall], "pending");
  const completed = assistantMessage(model, [toolCall], "toolUse");
  stream.push({ type: "start", partial: pending });
  stream.push({
    type: "toolcall_start",
    contentIndex: 0,
    partial: pending,
  });
  stream.push({
    type: "toolcall_delta",
    contentIndex: 0,
    delta: JSON.stringify(args),
    partial: pending,
  });
  stream.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: completed,
  });
  stream.push({ type: "done", reason: "toolUse", message: completed });
  return stream;
}

export function overflowStream(model) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(
    model,
    [],
    "error",
    "prompt is too long: 9999 tokens > 2000 maximum",
  );
  stream.push({ type: "start", partial: message });
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

export function errorStream(model, errorMessage) {
  const stream = createAssistantMessageEventStream();
  const pending = assistantMessage(model, [], "pending");
  const message = assistantMessage(model, [], "error", errorMessage);
  stream.push({ type: "start", partial: pending });
  stream.push({ type: "error", reason: "error", error: message });
  return stream;
}

export function createDeferredStream(model) {
  const stream = createAssistantMessageEventStream();
  const pending = assistantMessage(model, [], "pending");
  stream.push({ type: "start", partial: pending });
  return {
    stream,
    finish(text) {
      const message = assistantMessage(model, [{ type: "text", text }], "stop");
      stream.push({ type: "done", reason: "stop", message });
    },
    abort(errorMessage = "Request aborted") {
      const message = assistantMessage(model, [], "aborted", errorMessage);
      stream.push({ type: "error", reason: "aborted", error: message });
    },
  };
}

export function installScriptedStream(session, script) {
  const calls = [];
  session.agent.streamFunction = (model, context) => {
    calls.push(context);
    const response = script(calls.length - 1, context) ?? {
      type: "text",
      text: "test response",
    };
    if (response.type === "error") {
      return response.text === undefined
        ? overflowStream(model)
        : errorStream(model, response.text);
    }
    if (response.type === "toolCall") {
      return toolCallStream(model, response.id, response.name, response.args);
    }
    return textStream(model, response.text);
  };
  return calls;
}
