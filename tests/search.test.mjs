import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { importCore } from "./support/core.mjs";
import { createDirectoryLink, withTempDirectory } from "./support/helpers.mjs";
import {
  fakeExecuted,
  readFakeArgs,
  writeFakeExecutable,
} from "./support/fake-executable.mjs";

const core = await importCore();

test("a missing binary fails with a doctor hint and never downloads", async () => {
  await withTempDirectory("codepunk-search-", async (root) => {
    const tool = core.createSearchTool({
      cwd: root,
      environment: { PATH: "" },
    });
    const result = await tool.execute("call-1", {
      mode: "grep",
      query: "needle",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /rg is not installed/u);
    assert.match(result.content[0].text, /codepunk doctor/u);
  });
});

test("a relative PATH entry cannot supply the search binary", async () => {
  await withTempDirectory("codepunk-search-relative-", async (root) => {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, "bin"), { recursive: true });
    await writeFakeExecutable(path.join(workspace, "bin"), "rg", {
      stdout: "a.txt:1:needle\n",
    });
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment: { PATH: "bin" },
    });
    const result = await tool.execute("call-1", {
      mode: "grep",
      query: "needle",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /rg is not installed/u);
  });
});

test(
  "Windows resolves a spread environment's Path casing",
  { skip: process.platform !== "win32" },
  async () => {
    await withTempDirectory("codepunk-search-win-path-", async (root) => {
      await fs.writeFile(path.join(root, "rg.EXE"), "stub");
      const binary = await core.resolveSearchBinary("rg", {
        Path: root,
        PATHEXT: ".EXE",
      });
      assert.ok(binary);
      assert.equal(binary.path, path.join(root, "rg.EXE"));
      assert.match(binary.sha256, /^sha256:[0-9a-f]{64}$/u);
    });
  },
);

test("the search binary is pinned for the life of the tool", async () => {
  await withTempDirectory("codepunk-search-pinned-", async (root) => {
    const binA = path.join(root, "bin-a");
    const binB = path.join(root, "bin-b");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(binA);
    await fs.mkdir(binB);
    await fs.mkdir(workspace);
    await writeFakeExecutable(binA, "rg", { stdout: "a.txt:1:original\n" });
    await writeFakeExecutable(binB, "rg", { stdout: "a.txt:1:swapped\n" });
    const environment = { PATH: binA };
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment,
    });
    const first = await tool.execute("call-1", {
      mode: "grep",
      query: "original",
    });
    assert.match(first.content[0].text, /original/u);
    assert.match(first.details.binary_sha256, /^sha256:[0-9a-f]{64}$/u);

    environment.PATH = binB;
    const second = await tool.execute("call-2", {
      mode: "grep",
      query: "original",
    });
    assert.match(second.content[0].text, /original/u);
    assert.doesNotMatch(second.content[0].text, /swapped/u);
    assert.equal(await fakeExecuted(binB, "rg"), false);
  });
});

test("local rg output is bounded and paths stay inside the workspace", async () => {
  await withTempDirectory("codepunk-search-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeFakeExecutable(bin, "rg", {
      stdout: "a.txt:1:needle\n.env:1:SECRET\n",
    });
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment: { PATH: bin },
    });
    const result = await tool.execute("call-1", {
      mode: "grep",
      query: "needle",
      limit: 10_000,
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /a\.txt:1:needle/u);
    assert.doesNotMatch(result.content[0].text, /SECRET/u);
    const args = await readFakeArgs(bin, "rg");
    assert.equal(args.includes("--no-config"), true);
    const maxCountIndex = args.indexOf("--max-count");
    assert.equal(args[maxCountIndex + 1], "500");

    const escaped = await tool.execute("call-2", {
      mode: "grep",
      query: "needle",
      path: "..",
    });
    assert.equal(escaped.isError, true);
    assert.match(escaped.content[0].text, /outside the workspace/u);

    const empty = await tool.execute("call-3", { mode: "grep", query: " " });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /query is required/u);
  });
});

test("grep forwards Pi-compatible flags and preserves context lines", async () => {
  await withTempDirectory("codepunk-search-flags-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeFakeExecutable(bin, "rg", {
      stdout:
        "a.txt\u001f1\u001fneedle\n" +
        "b.txt\u001e2\u001econtext\n" +
        ".env\u001e3\u001eSECRET\n",
    });
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment: { PATH: bin },
    });
    const result = await tool.execute("call-flags", {
      mode: "grep",
      query: "Needle",
      glob: "./src/**/*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 10,
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /a\.txt:1:needle/u);
    assert.match(result.content[0].text, /b\.txt-2-context/u);
    assert.doesNotMatch(result.content[0].text, /SECRET/u);
    const args = await readFakeArgs(bin, "rg");
    assert.equal(args.includes("--fixed-strings"), true);
    assert.equal(args.includes("--ignore-case"), true);
    assert.equal(args[args.indexOf("--glob") + 1], "src/**/*.ts");
    assert.equal(args[args.indexOf("--context") + 1], "2");
    assert.equal(args.includes("\u001f"), true);
    assert.equal(args.includes("\u001e"), true);
  });
});

test("regex mode overrides the literal default", async () => {
  await withTempDirectory("codepunk-search-regex-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeFakeExecutable(bin, "rg", { stdout: "a.txt:1:needle\n" });
    const tool = core.createSearchTool({
      cwd: root,
      workspaceRoot: root,
      environment: { PATH: bin },
    });
    await tool.execute("call-regex", {
      mode: "grep",
      query: "n.+dle",
      regex: true,
    });
    const args = await readFakeArgs(bin, "rg");
    assert.equal(args.includes("--fixed-strings"), false);
  });
});

test("long lines are shortened and large output is not reported as an error", async () => {
  await withTempDirectory("codepunk-search-large-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    const long = "x".repeat(600);
    await writeFakeExecutable(bin, "rg", {
      stdout: Array.from(
        { length: 400 },
        (_value, index) => `a.txt:${index}:${long}`,
      ).join("\n"),
    });
    const tool = core.createSearchTool({
      cwd: root,
      workspaceRoot: root,
      environment: { PATH: bin },
    });
    const result = await tool.execute("call-large", {
      mode: "grep",
      query: "needle",
      limit: 500,
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.truncated, true);
    assert.match(result.content[0].text, /\[output truncated\]/u);
    assert.ok(
      result.content[0].text.length < 80_000,
      "the full 240KB generated output must not be returned",
    );
  });
});

test("search refuses a symlink that escapes the workspace", async () => {
  await withTempDirectory("codepunk-search-symlink-", async (root) => {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await createDirectoryLink(outside, path.join(workspace, "escape"));
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment: { PATH: "" },
    });
    const result = await tool.execute("call-1", {
      mode: "find",
      query: "*.txt",
      path: "escape",
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /symlink/u);
  });
});

test("local fd find mode is bounded and excludes Git metadata", async () => {
  await withTempDirectory("codepunk-search-fd-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeFakeExecutable(bin, "fd", { stdout: "a.txt\n" });
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const tool = core.createSearchTool({
      cwd: workspace,
      workspaceRoot: workspace,
      environment: { PATH: bin },
    });
    const result = await tool.execute("call-fd", {
      mode: "find",
      query: "*.txt",
      limit: 7,
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.binary, "fd");
    assert.equal(result.content[0].text, "a.txt");
    const args = await readFakeArgs(bin, "fd");
    assert.equal(args.includes("--exclude"), true);
    assert.equal(args[args.indexOf("--exclude") + 1], ".git");
    assert.equal(args[args.indexOf("--max-results") + 1], "7");
  });
});

test("grep caps total matches across files, not per file", async () => {
  await withTempDirectory("codepunk-search-limit-", async (root) => {
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await writeFakeExecutable(bin, "rg", {
      stdout:
        "a.txt:1:needle\na.txt:2:needle\nb.txt:1:needle\nb.txt:2:needle\n",
    });
    const tool = core.createSearchTool({
      cwd: root,
      workspaceRoot: root,
      environment: { PATH: bin },
    });
    const result = await tool.execute("call-limit", {
      mode: "grep",
      query: "needle",
      limit: 3,
    });
    assert.equal(result.structuredContent.output.split("\n").length, 3);
    assert.match(result.content[0].text, /\[output truncated\]/u);
    assert.equal(result.structuredContent.truncated, true);
  });
});

test("ls honors the limit and reports truncation", async () => {
  await withTempDirectory("codepunk-search-", async (root) => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await fs.writeFile(path.join(root, name), "x\n");
    }
    const tool = core.createSearchTool({
      cwd: root,
      environment: { PATH: "" },
    });
    const result = await tool.execute("call-1", { mode: "ls", limit: 2 });
    assert.equal(result.structuredContent.truncated, true);
    assert.equal(result.content[0].text.split("\n").length, 2);
  });
});
