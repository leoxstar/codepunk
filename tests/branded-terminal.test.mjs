import assert from "node:assert/strict";
import test from "node:test";
import { importSource } from "./support/core.mjs";

const terminalModule = await importSource(
  "packages/cli/src/branded-terminal.ts",
);

test("terminal branding rewrites Pi titles without touching product titles", () => {
  const calls = [];
  const inner = {
    setTitle: (title) => calls.push(["title", title]),
  };
  const terminal = new terminalModule.CodepunkTerminal(inner);

  terminal.setTitle("\u03c0 - session - repo");
  terminal.setTitle("pi - session");
  terminal.setTitle("\u03c0");
  terminal.setTitle("codepunk \u00b7 session abc");

  assert.deepEqual(calls, [
    ["title", "codepunk - session - repo"],
    ["title", "codepunk - session"],
    ["title", "codepunk"],
    ["title", "codepunk \u00b7 session abc"],
  ]);
});

test("terminal branding owns the OSC 7501 app name", () => {
  const calls = [];
  const inner = {
    setProgramStatus: (status) => calls.push(status),
  };
  const terminal = new terminalModule.CodepunkTerminal(inner);

  terminal.setProgramStatus({
    state: "blocked",
    app: "pi",
    kind: "permission",
    message: "Approval required",
  });

  assert.deepEqual(calls, [
    {
      state: "blocked",
      app: "codepunk",
      kind: "permission",
      message: "Approval required",
    },
  ]);
});
