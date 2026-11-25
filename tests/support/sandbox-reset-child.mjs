import { importCore, importSource } from "./core.mjs";

const core = await importCore();
const sandboxModule = await importSource("packages/core/src/sandbox/index.ts");
const role = process.argv[2] ?? "cancel";
if (role !== "cancel" && role !== "survive") {
  throw new Error(`unknown sandbox reset role: ${role}`);
}

const config = core.srtProfile({
  cwd: process.cwd(),
  workspaceRoot: process.cwd(),
  deliveryRoot: process.cwd(),
  codepunkHome: `${process.cwd()}/.codepunk-home`,
  writeSet: ["."],
});
config.network.httpProxyPort = 0;
config.network.socksProxyPort = 0;
config.network.parentProxy = { httpUrl: "http://127.0.0.1:9" };
config.network.strictAllowlist = true;
config.javaAgentJarPath = `${process.cwd()}/definitely-missing-java-agent.jar`;

const manager = sandboxModule.SandboxManager;

function writeResult(result) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

let result;
try {
  if (!manager.isSupportedPlatform()) {
    result = { skipped: "unsupported host platform" };
  } else {
    const dependencies = await manager.checkDependenciesAsync();
    if (dependencies.errors.length > 0) {
      result = { skipped: "unavailable srt dependencies" };
    } else {
      const initialize = manager.initialize(config);
      let initializedAfterReset = "not rejected";
      const resetStarted =
        role === "cancel" ? manager.reset() : Promise.resolve();
      try {
        await initialize;
      } catch (error) {
        initializedAfterReset = error.message;
      }
      await resetStarted;
      result = {
        canceled:
          initializedAfterReset === "initialize() was cancelled by reset()",
        message: initializedAfterReset,
        ...(role === "survive" ? { initialized: true, reset: false } : {}),
      };
    }
  }
} finally {
  // On Linux initialize() starts a socat bridge that keeps the event loop
  // alive until reset() tears it down. Exit deterministically either way.
  await manager.reset().catch(() => undefined);
}
await writeResult(result);
process.exit(0);
