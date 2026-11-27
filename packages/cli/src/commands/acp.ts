import { AcpServer, RuntimeControlBackend, createRuntime } from "codepunk-core";
import { readCliVersion } from "../build-info.ts";

export async function commandAcp(): Promise<number> {
  const agentVersion = await readCliVersion();
  const backend = new RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: (input) =>
      createRuntime({
        cwd: input?.cwd ?? process.cwd(),
        environment: process.env,
        headless: true,
        newSession: input?.sessionId === undefined,
        ...(input?.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
        bindMode: "print",
        allowMissingModel: true,
        allowUnsandboxedShell: false,
      }),
  });
  const server = new AcpServer({
    backend,
    input: process.stdin,
    output: process.stdout,
    agentVersion,
  });
  await server.run();
  return 0;
}
