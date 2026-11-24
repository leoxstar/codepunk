import { promises as fs } from "node:fs";
import path from "node:path";
import {
  MemoryManager,
  SessionStore,
  exportMemoryRecords,
  listProjectSessions,
  resolveSession,
} from "codepunk-core";
import type { CliOptions } from "../args/options.ts";
import { resolveProject } from "../run/project.ts";

type ProjectPaths = Awaited<ReturnType<typeof resolveProject>>["paths"];

async function appendMemoryEvent(
  paths: ProjectPaths,
  input: {
    scope: "user" | "project";
    action: "add" | "edit" | "delete" | "archive" | "reject";
    memoryId: string | null;
    contentSha256: string | null;
    sourceRefs: string[];
    reason: string | null;
  },
): Promise<void> {
  const sessions = await listProjectSessions(paths.home, paths.projectId);
  const store =
    sessions.length > 0
      ? await resolveSession({
          rootDir: paths.home,
          cwd: paths.cwd,
          projectRoot: paths.deliveryRoot,
          projectId: paths.projectId,
          sessionId: sessions[0]!.id,
        })
      : await SessionStore.create({
          rootDir: paths.home,
          cwd: paths.cwd,
          projectRoot: paths.deliveryRoot,
          projectId: paths.projectId,
        });
  const writer = await store.acquireWriter();
  try {
    await store.append("memory/write", {
      scope: input.scope,
      action: input.action,
      memory_id: input.memoryId,
      content_sha256: input.contentSha256,
      source_refs: input.sourceRefs,
      reason: input.reason,
    });
  } finally {
    await writer.release();
  }
}

export async function commandMemory(options: CliOptions): Promise<number> {
  const { paths, config } = await resolveProject(options);
  const memory = await MemoryManager.open({
    paths,
    enabled: config.memory.enabled,
    maxTokens: config.memory.max_tokens,
    defaultScope: config.memory.default_scope,
  });
  const command = options.positionals[1] ?? "list";
  const scope = options.scope ?? config.memory.default_scope;
  if (command === "export") {
    return memoryExport(options, paths, memory, scope);
  }
  if (command === "list" || command === "search") {
    return memorySearch(options, memory, scope, command);
  }
  if (command === "add") {
    return memoryAdd(options, paths, memory, scope);
  }
  return memoryRecord(options, paths, memory, scope, command);
}

async function memoryExport(
  options: CliOptions,
  paths: ProjectPaths,
  memory: MemoryManager,
  scope: "user" | "project",
): Promise<number> {
  const exported = exportMemoryRecords(memory, {
    scope,
    home: paths.home,
  });
  const serialized = `${JSON.stringify(exported, null, 2)}\n`;
  if (options.output !== undefined) {
    const target = path.resolve(options.output);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await fs.open(target, "w", 0o600);
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    process.stdout.write(`${target}\n`);
  } else {
    process.stdout.write(serialized);
  }
  return 0;
}

async function memorySearch(
  options: CliOptions,
  memory: MemoryManager,
  scope: "user" | "project",
  command: string,
): Promise<number> {
  const query =
    command === "search" ? options.positionals.slice(2).join(" ") : "";
  const result = await memory.search(query, scope, 20);
  for (const record of result.records) {
    process.stdout.write(
      `${record.id}\t${record.scope}\t${record.kind}\t${record.content}\n`,
    );
  }
  return 0;
}

async function memoryAdd(
  options: CliOptions,
  paths: ProjectPaths,
  memory: MemoryManager,
  scope: "user" | "project",
): Promise<number> {
  const content = options.positionals.slice(2).join(" ").trim();
  if (content.length === 0) {
    throw new Error("memory add requires text");
  }
  const result = await memory.add({
    scope,
    content,
    source: "user",
    source_refs: ["cli:memory-add"],
  });
  if (!result.ok) {
    await appendMemoryEvent(paths, {
      scope,
      action: "reject",
      memoryId: result.record?.id ?? null,
      contentSha256: result.record?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-add"],
      reason: result.reason,
    });
    throw new Error(`memory add rejected: ${result.reason}`);
  }
  await appendMemoryEvent(paths, {
    scope,
    action: "add",
    memoryId: result.record?.id ?? null,
    contentSha256: result.record?.content_sha256 ?? null,
    sourceRefs: ["cli:memory-add"],
    reason: null,
  });
  process.stdout.write(`${result.record?.id}\n`);
  return 0;
}

async function memoryRecord(
  options: CliOptions,
  paths: ProjectPaths,
  memory: MemoryManager,
  scope: "user" | "project",
  command: string,
): Promise<number> {
  const id = options.positionals[2];
  if (id === undefined) {
    throw new Error(`memory ${command} requires an id`);
  }
  const store = memory.storeFor(scope);
  if (command === "edit") {
    const content = options.positionals.slice(3).join(" ").trim();
    if (content.length === 0) {
      throw new Error("memory edit requires text");
    }
    const result = await store.edit(id, content);
    if (!result.ok) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-edit"],
        reason: result.reason,
      });
      throw new Error(`memory edit rejected: ${result.reason}`);
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "edit",
      memoryId: id,
      contentSha256: result.record?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-edit"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  if (command === "delete") {
    const existing = store.records.find((record) => record.id === id);
    if (!(await store.delete(id))) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-delete"],
        reason: "not_found",
      });
      throw new Error("memory record was not found");
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "delete",
      memoryId: id,
      contentSha256: existing?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-delete"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  if (command === "archive") {
    const existing = store.records.find((record) => record.id === id);
    if (!(await store.archive(id))) {
      await appendMemoryEvent(paths, {
        scope,
        action: "reject",
        memoryId: id,
        contentSha256: null,
        sourceRefs: ["cli:memory-archive"],
        reason: "not_found",
      });
      throw new Error("memory record was not found");
    }
    await appendMemoryEvent(paths, {
      scope,
      action: "archive",
      memoryId: id,
      contentSha256: existing?.content_sha256 ?? null,
      sourceRefs: ["cli:memory-archive"],
      reason: null,
    });
    process.stdout.write(`${id}\n`);
    return 0;
  }
  throw new Error(`unknown memory command: ${command}`);
}
