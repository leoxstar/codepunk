import { AcpServer, RuntimeControlBackend, createRuntime } from "codepunk-core";

export async function commandAcp(): Promise<number> {
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
  });
  await server.run();
  return 0;
}
