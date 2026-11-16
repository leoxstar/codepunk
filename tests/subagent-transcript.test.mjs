import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./support/core.mjs";

function line(event) {
  return `${JSON.stringify(event)}\n`;
}

test("subagent transcript keeps complete tool output and live assistant text", async () => {
  const { SubagentTranscriptDocument } = await importSource(
    "packages/cli/src/subagent-transcript.ts",
  );
  const document = new SubagentTranscriptDocument();
  const fullOutput = `${"0123456789abcdef".repeat(2_000)}FULL_OUTPUT_END`;
  document.append(
    [
      line({
        type: "message_start",
        message: { role: "assistant", content: [] },
      }),
      line({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "LIVE_TEXT" },
      }),
      line({
        type: "tool_execution_start",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "fixture.txt" },
      }),
      line({
        type: "tool_execution_update",
        toolCallId: "call-read",
        toolName: "read",
        args: { path: "fixture.txt" },
        partialResult: {
          content: [{ type: "text", text: "PARTIAL_OUTPUT" }],
        },
      }),
      line({
        type: "tool_execution_end",
        toolCallId: "call-read",
        toolName: "read",
        result: {
          content: [{ type: "text", text: fullOutput }],
          details: { lines: 2_001 },
        },
        isError: false,
        durationMs: 12,
      }),
      line({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "CHILD_DONE" }],
        },
      }),
      line({ type: "agent_settled", aborted: false }),
    ].join(""),
  );

  assert.equal(document.parsedEvents, 7);
  const assistant = document.blocks.find((block) => block.kind === "assistant");
  assert.equal(assistant?.text, "CHILD_DONE");
  assert.equal(assistant?.running, false);
  const tool = document.blocks.find((block) => block.kind === "tool");
  assert.equal(tool?.toolName, "read");
  assert.equal(tool?.running, false);
  assert.equal(tool?.durationMs, 12);
  assert.equal(tool?.output, fullOutput);
  assert.equal(tool?.output.length, 32_015);
  assert.deepEqual(tool?.toolArguments, { path: "fixture.txt" });
  assert.deepEqual(tool?.details, { lines: 2_001 });
});

test("subagent transcript holds split lines and replaces partial tool output", async () => {
  const { SubagentTranscriptDocument } = await importSource(
    "packages/cli/src/subagent-transcript.ts",
  );
  const document = new SubagentTranscriptDocument();
  const start = line({
    type: "tool_execution_start",
    toolCallId: "call-write",
    toolName: "write",
    args: { path: "note.txt" },
  });
  document.append(start.slice(0, 17));
  assert.equal(document.blocks.length, 0);
  document.append(start.slice(17));
  const tool = document.blocks[0];
  assert.equal(tool?.kind, "tool");
  assert.equal(tool?.running, true);

  const update = line({
    type: "tool_execution_update",
    toolCallId: "call-write",
    toolName: "write",
    args: { path: "note.txt" },
    partialResult: { content: [{ type: "text", text: "PARTIAL" }] },
  });
  document.append(update.slice(0, 23));
  assert.equal(tool?.output, "");
  document.append(update.slice(23));
  assert.equal(tool?.output, "PARTIAL");
  assert.equal(document.blocks.length, 1);
});

test("subagent transcript exposes malformed child output instead of dropping it", async () => {
  const { SubagentTranscriptDocument } = await importSource(
    "packages/cli/src/subagent-transcript.ts",
  );
  const document = new SubagentTranscriptDocument();
  document.append("{not-json\n");
  assert.equal(document.unparsedLines, 1);
  assert.equal(document.blocks.length, 1);
  assert.equal(document.blocks[0]?.kind, "raw");
  assert.equal(document.blocks[0]?.text, "{not-json");
});
