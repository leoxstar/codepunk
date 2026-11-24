import {
  findDeliveryRoot,
  listProjectSessions,
  projectPaths,
  searchProjectSessions,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveResumeTarget, resumeChoiceLabel } from "../session-resume.ts";
import { runTui } from "../run/interactive.ts";

export async function commandResume(options: CliOptions): Promise<number> {
  const conflicting = [
    options.print ? "--print" : undefined,
    options.session !== undefined ? "--session" : undefined,
    options.continueSession ? "--continue" : undefined,
    options.fork !== undefined ? "--fork" : undefined,
    options.newSession ? "--new-session" : undefined,
    options.newSessionId !== undefined ? "--new-session-id" : undefined,
    options.parentSessionId !== undefined ? "--parent-session-id" : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (conflicting.length > 0) {
    throw new Error(`resume cannot be combined with ${conflicting.join(", ")}`);
  }
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error(
      "resume needs an interactive terminal; use codepunk -p --session <id> <prompt> for print mode",
    );
  }
  const project = await findDeliveryRoot(process.cwd());
  const paths = projectPaths(project);
  const entries = await listProjectSessions(paths.home, paths.projectId);
  const resolution = await resolveResumeTarget(
    entries,
    options.positionals.slice(1).join(" "),
    async (query) => {
      const result = await searchProjectSessions({
        rootDir: paths.home,
        projectId: paths.projectId,
        query,
        limit: 60,
      });
      for (const warning of result.warnings) {
        process.stderr.write(`codepunk: ${warning}\n`);
      }
      return result.matches.map((hit) => hit.session_id);
    },
  );
  if (resolution.kind === "none") {
    throw new Error(resolution.message);
  }
  let sessionId: string;
  if (resolution.kind === "session") {
    sessionId = resolution.entry.id;
  } else {
    const { selectTerminalChoice, TerminalSelectCancelledError } =
      await import("../terminal-select.ts");
    try {
      sessionId = await selectTerminalChoice<string>(
        resolution.title,
        resolution.entries.map((entry) => ({
          label: resumeChoiceLabel(entry),
          value: entry.id,
        })),
      );
    } catch (error) {
      if (error instanceof TerminalSelectCancelledError) {
        throw new Error("resume cancelled; no session was selected");
      }
      throw error;
    }
  }
  return runTui({ ...options, session: sessionId, positionals: [] });
}
