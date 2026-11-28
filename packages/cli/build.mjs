import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLI_DIR, "..", "..");
const require = createRequire(import.meta.url);

// Pi transitive packages that must remain external alongside direct runtime
// dependencies so CJS/ESM module singletons and native assets stay intact (D73).
const EXTRA_EXTERNALS = [
  "node-pty",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-schema",
  "@earendil-works/pi-telemetry",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveGitCommit() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return sha.length > 0 ? sha : "dev";
  } catch {
    return "dev";
  }
}

function resolveSrtVersion() {
  const pkgPath = require.resolve(
    "@anthropic-ai/sandbox-runtime/package.json",
  );
  const pkg = readJson(pkgPath);
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(
      "unable to determine @anthropic-ai/sandbox-runtime version",
    );
  }
  return pkg.version;
}

function deriveExternals(cliPkg) {
  const names = new Set([
    ...Object.keys(cliPkg.dependencies ?? {}),
    ...EXTRA_EXTERNALS,
  ]);
  const externals = [];
  for (const name of [...names].sort()) {
    externals.push(name);
    if (name !== "node-pty") {
      externals.push(`${name}/*`);
    }
  }
  return externals;
}

async function main() {
  const cliPkg = readJson(path.join(CLI_DIR, "package.json"));
  const srtVersion = resolveSrtVersion();
  const buildCommit = resolveGitCommit();
  const define = {
    __CODEPUNK_VERSION__: JSON.stringify(cliPkg.version),
    __SRT_VERSION__: JSON.stringify(srtVersion),
    __BUILD_COMMIT__: JSON.stringify(buildCommit),
  };

  await esbuild.build({
    entryPoints: [path.join(CLI_DIR, "src", "index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    allowOverwrite: true,
    outfile: path.join(CLI_DIR, "dist", "index.js"),
    banner: {
      js: "import { createRequire as __nodeCreateRequire } from 'node:module'; const require = __nodeCreateRequire(import.meta.url);",
    },
    external: deriveExternals(cliPkg),
    define,
  });

  await esbuild.build({
    entryPoints: [
      path.join(REPO_ROOT, "packages", "core", "src", "plugin", "host-child.ts"),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    outfile: path.join(CLI_DIR, "dist", "host-child.js"),
    define,
  });
}

await main();
