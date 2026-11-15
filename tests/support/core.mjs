import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(TESTS_DIR, "..", "..");

const SOURCE_PACKAGES = new Map([
  [
    "@codepunk/protocol",
    path.join(REPO_ROOT, "packages", "protocol", "src", "index.ts"),
  ],
  [
    "@codepunk/core",
    path.join(REPO_ROOT, "packages", "core", "src", "index.ts"),
  ],
]);

let registered = false;

function ensureHooks() {
  if (registered) {
    return;
  }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const source = SOURCE_PACKAGES.get(specifier);
      if (source !== undefined) {
        return { url: pathToFileURL(source).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  registered = true;
}

export async function importCore() {
  ensureHooks();
  return import(pathToFileURL(SOURCE_PACKAGES.get("@codepunk/core")).href);
}

export async function importProtocol() {
  ensureHooks();
  return import(pathToFileURL(SOURCE_PACKAGES.get("@codepunk/protocol")).href);
}

export async function importSource(relativePath) {
  ensureHooks();
  return import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href);
}
