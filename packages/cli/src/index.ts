#!/usr/bin/env node
import { enableCompileCache } from "node:module";

// Cache compiled bytecode across runs; session startup loads hundreds of
// dependency modules, and recompiling them on every launch dominates it.
try {
  enableCompileCache();
} catch {
  // Best effort only; startup must not fail because the cache is unusable.
}

import { ConfigError, verifyGuardedHostLaunch } from "codepunk-core";
import type { CliOptions } from "./args/options.ts";
import { parseCli } from "./args/parse.ts";
import { subcommandUsage, usage } from "./args/usage.ts";
import { formatBuildIdentity, inspectCliBuild } from "./build-info.ts";
import { commandAcp } from "./commands/acp.ts";
import { commandCapabilities } from "./commands/capabilities.ts";
import { commandCompletion } from "./commands/completion.ts";
import { commandConfig } from "./commands/config.ts";
import { commandDaemon } from "./commands/daemon.ts";
import { commandDoctor } from "./commands/doctor.ts";
import { commandExport } from "./commands/export.ts";
import {
  commandBackup,
  commandGc,
  commandMigrate,
} from "./commands/maintenance.ts";
import { commandMcp } from "./commands/mcp.ts";
import { commandMemory } from "./commands/memory.ts";
import { commandModels } from "./commands/models.ts";
import { commandPackage } from "./commands/package.ts";
import { commandPermissions } from "./commands/permissions.ts";
import { commandPin } from "./commands/pin.ts";
import { commandPlugins } from "./commands/plugins.ts";
import { commandResume } from "./commands/resume.ts";
import { commandSessions } from "./commands/sessions.ts";
import { commandSign } from "./commands/sign.ts";
import { commandSkills } from "./commands/skills.ts";
import { commandTrust } from "./commands/trust.ts";
import { commandView } from "./commands/view.ts";
import { runTui } from "./run/interactive.ts";
import { runPrint } from "./run/print.ts";
import { readPrompt } from "./run/project.ts";

const commandRunners: Record<string, (options: CliOptions) => Promise<number>> =
  {
    gc: commandGc,
    migrate: commandMigrate,
    backup: commandBackup,
    resume: commandResume,
    sessions: commandSessions,
    prune: commandSessions,
    export: commandExport,
    pin: commandPin,
    sign: commandSign,
    memory: commandMemory,
    models: commandModels,
    doctor: commandDoctor,
    config: commandConfig,
    permissions: commandPermissions,
    permission: commandPermissions,
    trust: commandTrust,
    capabilities: commandCapabilities,
    mcp: commandMcp,
    skills: commandSkills,
    plugins: commandPlugins,
    daemon: commandDaemon,
    view: commandView,
    acp: () => commandAcp(),
    completion: commandCompletion,
    install: (options) => commandPackage(options, "install"),
    upgrade: (options) => commandPackage(options, "upgrade"),
    uninstall: (options) => commandPackage(options, "uninstall"),
  };

async function main(argv: string[]): Promise<number> {
  const options = parseCli(argv);
  const command = options.positionals[0];
  if (options.guardedHostLaunch) {
    verifyGuardedHostLaunch();
  }
  if (options.version) {
    process.stdout.write(`${formatBuildIdentity(await inspectCliBuild())}\n`);
    return 0;
  }
  if (options.help) {
    const scoped = subcommandUsage(command);
    if (scoped !== undefined) {
      process.stdout.write(scoped);
      return 0;
    }
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (command !== undefined && Object.hasOwn(commandRunners, command)) {
    return commandRunners[command]!(options);
  }
  const prompt = await readPrompt(options.positionals);
  const usePrint = options.print || process.stdin.isTTY !== true;
  if (usePrint) {
    if (prompt === null) {
      throw new Error("print mode requires a prompt or piped stdin");
    }
    return runPrint(options, prompt);
  }
  return runTui(options);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `codepunk: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof ConfigError ? 2 : 1;
  });
