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
if (!manager.isSupportedPlatform()) {
  console.log(JSON.stringify({ skipped: "unsupported host platform" }));
} else {
  const dependencies = await manager.checkDependenciesAsync();
  if (dependencies.errors.length > 0) {
    console.log(JSON.stringify({ skipped: "unavailable srt dependencies" }));
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

    console.log(
      JSON.stringify({
        canceled:
          initializedAfterReset === "initialize() was cancelled by reset()",
        message: initializedAfterReset,
        ...(role === "survive" ? { initialized: true, reset: false } : {}),
      }),
    );
  }
}
