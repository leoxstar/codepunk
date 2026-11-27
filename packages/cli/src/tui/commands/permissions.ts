import { notify } from "../format/notify.ts";
import { configurePermissions } from "./permission-actions.ts";
import { exportSession } from "codepunk-core";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiCommand } from "../define-command.ts";
import { commandContext } from "../command-context.ts";
import type { TuiState } from "../state.ts";
import { defineCommand } from "../define-command.ts";

export function permissionsCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "permissions",
    description: "Show or change approval, autonomy, and sandbox modes",
    handler: commandContext(state, async (_runtime, context, args) => {
      await configurePermissions(state, context, args);
    }),
  });
}

export function cp_exportCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "cp-export",
    description: "Export a redacted audit transcript",
    handler: commandContext(state, async (runtime, context) => {
      const exported = await exportSession(runtime.session);
      const target = path.join(
        runtime.paths.artifactsDir,
        `${runtime.session.sessionId}.md`,
      );
      const manifestTarget = path.join(
        runtime.paths.artifactsDir,
        `${runtime.session.sessionId}.manifest.json`,
      );
      await fs.mkdir(path.dirname(target), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(target, exported.transcript, { mode: 0o600 });
      await fs.writeFile(
        manifestTarget,
        `${JSON.stringify(exported.manifest, null, 2)}\n`,
        { mode: 0o600 },
      );
      await notify(
        context,
        `Exported redacted transcript: ${target}\nManifest: ${manifestTarget}`,
      );
    }),
  });
}

export function signCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "sign",
    description: "Sign the current settled run",
    handler: commandContext(state, async (runtime, context, args) => {
      if (process.stdin.isTTY !== true) {
        context.ui.notify("sign requires a top-level TTY", "error");
        return;
      }
      const requested = args.trim();
      if (
        requested !== "" &&
        requested !== "complete" &&
        requested !== "incomplete"
      ) {
        context.ui.notify("usage: /sign [complete|incomplete]", "warning");
        return;
      }
      const runId = state.lastRunId ?? runtime.host.currentRunId;
      const ended = runtime.session.allEvents.some(
        (event) => event.kind === "run/end" && event.data.run_id === runId,
      );
      if (!ended) {
        context.ui.notify("the current run has no durable run/end", "error");
        return;
      }
      const verdict =
        requested === "complete" || requested === "incomplete"
          ? requested
          : await context.ui.select(`Sign ${runId}`, [
              "Sign as complete",
              "Sign as incomplete",
              "Cancel",
            ]);
      if (verdict === undefined || verdict === "Cancel") {
        return;
      }
      const resolvedVerdict: "complete" | "incomplete" =
        verdict === "Sign as incomplete" || verdict === "incomplete"
          ? "incomplete"
          : "complete";
      try {
        const result = await runtime.signInProcess(resolvedVerdict, {
          channel: "tui",
          tty: true,
        });
        await notify(
          context,
          `verdict ${result.verdict.verdict} · ${result.artifactPath}`,
        );
      } catch (error) {
        context.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    }),
  });
}

export function rememberCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "remember",
    description: "Remember a user or project fact",
    handler: commandContext(state, async (runtime, context, args) => {
      const scopeMatch = /(?:^|\s)--scope\s+(user|project)\s*$/u.exec(args);
      const scope =
        scopeMatch?.[1] === "user" || scopeMatch?.[1] === "project"
          ? scopeMatch[1]
          : "project";
      const content =
        scopeMatch === null ? args : args.slice(0, scopeMatch.index).trim();
      if (content.length === 0) {
        context.ui.notify(
          "usage: /remember <text> [--scope user|project]",
          "warning",
        );
        return;
      }
      const result = await runtime.memory.add({
        scope,
        content,
        source: "user",
        source_refs: [`session:${runtime.session.sessionId}`],
      });
      await runtime.recordMemoryWrite({
        scope,
        action: result.ok ? "add" : "reject",
        memoryId: result.record?.id ?? null,
        contentSha256: result.record?.content_sha256 ?? null,
        sourceRefs: [`session:${runtime.session.sessionId}`],
        reason: result.ok ? null : result.reason,
      });
      context.ui.notify(
        result.ok
          ? `remembered ${result.record?.id}`
          : `memory rejected: ${result.reason}`,
        result.ok ? "info" : "warning",
      );
    }),
  });
}

export async function openMemoryBrowserLoop(
  runtime: NonNullable<TuiState["runtime"]>,
  context: ExtensionContext,
): Promise<void> {
  if (typeof context.ui.custom !== "function") {
    const result = await runtime.memory.search("", "all", 8);
    await notify(
      context,
      result.records.length === 0
        ? "No memory records matched."
        : result.records
            .map((record) => `${record.id} [${record.scope}] ${record.content}`)
            .join("\n"),
    );
    return;
  }
  const [{ createMemoryBrowser }, { defaultViewportHeight }] =
    await Promise.all([
      import("../components/memory-browser.ts"),
      import("../components/frame.ts"),
    ]);
  for (;;) {
    const allRecords = [
      ...runtime.memory.storeFor("project").records,
      ...runtime.memory.storeFor("user").records,
    ]
      .filter((record) => record.status !== "archived")
      .map((record) => ({
        id: record.id,
        scope: record.scope,
        content: record.content,
      }));
    const action = await context.ui.custom<
      | { action: "archive" | "delete"; id: string; scope: "user" | "project" }
      | { action: "add" }
      | null
    >((_tui, theme, keybindings, done) =>
      createMemoryBrowser(
        {
          entries: allRecords,
          viewportHeight: defaultViewportHeight(),
        },
        theme,
        keybindings,
        done,
      ),
    );
    if (action === null || action === undefined) {
      return;
    }
    if (action.action === "add") {
      const text = (
        await context.ui.input(
          "Remember note (project scope)",
          "Enter a concise fact to remember",
        )
      )?.trim();
      if (text && text.length > 0) {
        const added = await runtime.memory.add({
          scope: "project",
          content: text,
          source: "user",
          source_refs: [`session:${runtime.session.sessionId}`],
        });
        await runtime.recordMemoryWrite({
          scope: "project",
          action: added.ok ? "add" : "reject",
          memoryId: added.record?.id ?? null,
          contentSha256: added.record?.content_sha256 ?? null,
          sourceRefs: [`session:${runtime.session.sessionId}`],
          reason: added.ok ? null : added.reason,
        });
        context.ui.notify(
          added.ok
            ? `remembered ${added.record?.id}`
            : `memory rejected: ${added.reason}`,
          added.ok ? "info" : "warning",
        );
      }
      continue;
    }
    const store = runtime.memory.storeFor(action.scope);
    const target = store.records.find((r) => r.id === action.id);
    if (target !== undefined) {
      const changed =
        action.action === "delete"
          ? await store.delete(action.id)
          : await store.archive(action.id);
      await runtime.recordMemoryWrite({
        scope: action.scope,
        action: action.action,
        memoryId: action.id,
        contentSha256: target.content_sha256,
        sourceRefs: [`session:${runtime.session.sessionId}`],
        reason: changed ? null : "not_found",
      });
      context.ui.notify(
        changed
          ? `${action.action === "delete" ? "deleted" : "archived"} ${action.id}`
          : `memory record was not found: ${action.id}`,
        changed ? "info" : "warning",
      );
    }
  }
}

export function memoryCommand(state: TuiState): TuiCommand {
  return defineCommand({
    name: "memory",
    description: "List, search, delete, or archive memory",
    handler: commandContext(state, async (runtime, context, args) => {
      if (runtime.memory.warnings.length > 0) {
        context.ui.notify(runtime.memory.warnings.join("\n"), "warning");
      }
      const tokens = args.split(/\s+/u).filter(Boolean);
      const subcommand = tokens[0];
      const argument = tokens.slice(1).join(" ");
      if (subcommand === "delete" || subcommand === "archive") {
        if (argument.length === 0) {
          context.ui.notify(
            `usage: /memory ${subcommand} <memory-id>`,
            "warning",
          );
          return;
        }
        for (const scope of ["user", "project"] as const) {
          const store = runtime.memory.storeFor(scope);
          const record = store.records.find(
            (candidate) => candidate.id === argument,
          );
          if (record === undefined) {
            continue;
          }
          const changed =
            subcommand === "delete"
              ? await store.delete(argument)
              : await store.archive(argument);
          await runtime.recordMemoryWrite({
            scope,
            action: subcommand,
            memoryId: argument,
            contentSha256: record.content_sha256,
            sourceRefs: [`session:${runtime.session.sessionId}`],
            reason: changed ? null : "not_found",
          });
          context.ui.notify(
            changed
              ? `${subcommand === "delete" ? "deleted" : "archived"} ${argument}`
              : `memory record was not found: ${argument}`,
            changed ? "info" : "warning",
          );
          return;
        }
        context.ui.notify(
          `memory record was not found: ${argument}`,
          "warning",
        );
        return;
      }
      if (subcommand === "search" && argument.length === 0) {
        context.ui.notify("usage: /memory search <query>", "warning");
        return;
      }
      if (
        subcommand !== undefined &&
        subcommand !== "list" &&
        subcommand !== "search"
      ) {
        context.ui.notify(
          "usage: /memory [list|search <query>|delete <memory-id>|archive <memory-id>]",
          "warning",
        );
        return;
      }
      if (subcommand === undefined && typeof context.ui.custom === "function") {
        await openMemoryBrowserLoop(runtime, context);
        return;
      }
      const query = subcommand === "search" ? argument : "";
      const result = await runtime.memory.search(query, "all", 8);
      await notify(
        context,
        result.records.length === 0
          ? "No memory records matched."
          : result.records
              .map(
                (record) => `${record.id} [${record.scope}] ${record.content}`,
              )
              .join("\n"),
      );
    }),
  });
}
