import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sandboxRuntime = await import(
  pathToFileURL(
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "packages",
      "cli",
      "node_modules",
      "@anthropic-ai",
      "sandbox-runtime",
      "dist",
      "index.js",
    ),
  ).href
);
const originalInitialize = sandboxRuntime.SandboxManager.initialize;
const marker = process.env.CODEPUNK_TEST_SANDBOX_MARKER;

sandboxRuntime.SandboxManager.initialize = async (...args) => {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  if (marker !== undefined) {
    await fs.writeFile(marker, "initializing");
  }
  const result = await originalInitialize(...args);
  if (marker !== undefined) {
    await fs.writeFile(marker, "ready");
  }
  return result;
};
