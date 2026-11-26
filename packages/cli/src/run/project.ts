import { fstatSync } from "node:fs";
import {
  ensureProjectConfigDir,
  ensureProjectRegistration,
  findDeliveryRoot,
  forkSession,
  initializeStateVersion,
  loadConfig,
  projectPaths,
  readStateVersionInfo,
  resolveAdditionalWorkspaceRoots,
  resolveWorkspaceTrust,
  type CodepunkConfig,
  type WorkspaceTrust,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { preparedConfigOverrides } from "../args/overrides.ts";
import { workspaceTrustOverride } from "./trust-prompt.ts";

export async function resolveProject(options: CliOptions): Promise<{
  paths: ReturnType<typeof projectPaths>;
  config: CodepunkConfig;
  workspaceTrust: WorkspaceTrust;
}> {
  if (options.dangerouslyBypass) {
    throw new Error(
      "--dangerously-bypass-approvals-and-sandbox applies to interactive sessions only",
    );
  }
  const project = await findDeliveryRoot(process.cwd());
  const initialPaths = projectPaths(project);
  const additionalRoots = await resolveAdditionalWorkspaceRoots({
    cwd: project.cwd,
    primaryRoot: project.deliveryRoot,
    codepunkHome: initialPaths.home,
    directories: options.additionalDirs,
  });
  const paths = projectPaths(project, initialPaths.home, additionalRoots);
  await initializeStateVersion(paths.home);
  // Spec 0016 C2: a newer state-version.json keeps sessions readable but
  // maintenance commands refuse; warn once here so interactive and print
  // sessions surface it without blocking.
  const stateVersion = await readStateVersionInfo(paths.home);
  if (stateVersion.newer) {
    process.stderr.write(
      `warning: codepunk home state version ${stateVersion.current} is newer than supported ${stateVersion.supported}; sessions stay readable, but upgrade codepunk before running maintenance commands\n`,
    );
  }
  await ensureProjectRegistration(project, paths);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  if (workspaceTrust.grants.config || workspaceTrust.grants.policy) {
    await ensureProjectConfigDir(paths);
  }
  const loaded = await loadConfig(
    paths,
    process.env,
    await preparedConfigOverrides(options, paths),
    { projectTrusted: workspaceTrust.grants.config },
  );
  return { paths, config: loaded.config, workspaceTrust };
}

export async function prepareFork(
  options: CliOptions,
): Promise<string | undefined> {
  if (options.fork === undefined) {
    return undefined;
  }
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const workspaceTrust = await resolveWorkspaceTrust({
    cwd: project.cwd,
    root: project.deliveryRoot,
    home: paths.home,
    ...workspaceTrustOverride(options),
  });
  const loaded = await loadConfig(
    paths,
    process.env,
    {},
    {
      projectTrusted: workspaceTrust.grants.config,
    },
  );
  const result = await forkSession({
    rootDir: paths.home,
    cwd: paths.cwd,
    projectRoot: paths.deliveryRoot,
    projectId: paths.projectId,
    parentSessionId: options.fork,
    heartbeatMs: loaded.config.session.heartbeat_seconds * 1_000,
    leaseMs: loaded.config.session.lease_seconds * 1_000,
  });
  process.stderr.write(
    `codepunk: forked ${result.parentSessionId} -> ${result.sessionId}\n`,
  );
  return result.sessionId;
}

export async function resolveDaemonProject(): Promise<
  ReturnType<typeof projectPaths>
> {
  const project = await findDeliveryRoot(process.cwd());
  return projectPaths(project);
}

async function readPipedStdin(
  waitForFirstByteMs: number | null,
): Promise<string> {
  if (process.stdin.isTTY === true) {
    return "";
  }
  let stat;
  try {
    stat = fstatSync(0);
  } catch {
    return "";
  }
  if (stat.isCharacterDevice()) {
    return "";
  }
  const chunks: Buffer[] = [];
  if (stat.isFile() || waitForFirstByteMs === null) {
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  return await new Promise<string>((resolve) => {
    let sawData = false;
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      if (!sawData) {
        process.stdin.pause();
        (process.stdin as NodeJS.ReadStream & { unref?: () => void }).unref?.();
        resolve("");
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    };
    const onData = (chunk: Buffer | string) => {
      sawData = true;
      clearTimeout(timer);
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => finish();
    const timer = setTimeout(() => {
      if (!sawData) {
        finish();
      }
    }, waitForFirstByteMs);
    timer.unref();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onEnd);
    process.stdin.resume();
  });
}

export async function readPrompt(
  positionals: string[],
): Promise<string | null> {
  const positional = positionals.join(" ").trim();
  if (positional.length > 0) {
    const piped = await readPipedStdin(150);
    if (piped.length > 0) {
      return `${positional}\n\n${piped}`;
    }
    return positional;
  }
  const piped = await readPipedStdin(null);
  return piped.length > 0 ? piped : null;
}

export function sessionSelector(value: string | undefined): {
  sessionId?: string;
  sessionPath?: string;
} {
  if (value === undefined) {
    return {};
  }
  return value.includes("/") || value.includes("\\")
    ? { sessionPath: value }
    : { sessionId: value };
}
