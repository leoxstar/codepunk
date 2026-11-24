import { AcpServer, RuntimeControlBackend, createRuntime } from "codepunk-core";

export async function commandAcp(): Promise<number> {
  const backend = new RuntimeControlBackend({
    cwd: process.cwd(),
    createRuntime: () =>
      createRuntime({
        cwd: process.cwd(),
        environment: process.env,
        headless: true,
        newSession: true,
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
