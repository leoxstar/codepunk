import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { importSource } from "./support/core.mjs";
import {
  ensureBuilt,
  withTempDirectory,
  withoutAmbientProviderEnv,
} from "./support/helpers.mjs";

const execFileAsync = promisify(execFile);
const BASE_ENV = withoutAmbientProviderEnv();

const { ResumeHint, formatResumeHint, resumeCommand, sessionHasConversation } =
  await importSource("packages/cli/src/exit-hint.ts");
const { matchSessionChoice, resolveResumeTarget, resumeChoiceLabel } =
  await importSource("packages/cli/src/session-resume.ts");

function session(sessionId, kinds) {
  return { sessionId, allEvents: kinds.map((kind) => ({ kind })) };
}

function fakeOutput({ isTTY = true, color = false, fail = false } = {}) {
  const writes = [];
  return {
    writes,
    output: () => ({
      isTTY,
      color,
      write: (text) => {
        if (fail) {
          throw new Error("EIO");
        }
        writes.push(text);
      },
    }),
  };
}

const ENTRIES = [
  {
    id: "01KAAAAAAAAAAAAAAAAAAAAAAA",
    updated_at: "2026-11-23T10:00:00.000Z",
    title: "fix login",
    parent_session_id: null,
  },
  {
    id: "01KAAAAAAAAAAAAAAAAAAAAAAB",
    updated_at: "2026-11-22T10:00:00.000Z",
    title: null,
    parent_session_id: "01KAAAAAAAAAAAAAAAAAAAAAAA",
  },
  {
    id: "01KBBBBBBBBBBBBBBBBBBBBBBB",
    updated_at: "2026-11-21T10:00:00.000Z",
    title: "docs",
    parent_session_id: null,
  },
];

function noSearch() {
  throw new Error("search must not run for this argument");
}

test("only a session with a conversation is worth a resume hint", () => {
  assert.equal(sessionHasConversation(session("s1", ["user/input"])), true);
  assert.equal(sessionHasConversation(session("s1", ["session/forked"])), true);
  assert.equal(
    sessionHasConversation(
      session("s1", ["trust/decision", "context/loaded", "mcp/server_start"]),
    ),
    false,
  );
  assert.equal(sessionHasConversation(session("s1", [])), false);
});

test("the resume hint names the product command, not Pi", () => {
  assert.equal(resumeCommand("01KABC_d-9"), "codepunk resume 01KABC_d-9");
  assert.equal(resumeCommand("has space"), 'codepunk resume "has space"');
  assert.equal(
    formatResumeHint("01KABC", false),
    "To resume this session: codepunk resume 01KABC\n",
  );
  assert.equal(
    formatResumeHint("01KABC", true),
    "\u001b[2mTo resume this session:\u001b[0m codepunk resume 01KABC\n",
  );
  assert.doesNotMatch(formatResumeHint("01KABC", false), /\bpi\b/u);
});

test("an armed hint prints exactly once on a TTY", () => {
  const sink = fakeOutput();
  const hint = new ResumeHint(sink.output);
  hint.arm(session("01KABC", ["user/input"]));
  assert.equal(hint.armedSessionId, "01KABC");
  assert.equal(hint.print(), true);
  assert.equal(hint.print(), false);
  assert.deepEqual(sink.writes, [
    "To resume this session: codepunk resume 01KABC\n",
  ]);
});

test("the hint stays silent without a conversation, a TTY, or arming", () => {
  const empty = fakeOutput();
  const emptyHint = new ResumeHint(empty.output);
  emptyHint.arm(session("01KABC", ["context/loaded"]));
  assert.equal(emptyHint.armedSessionId, null);
  assert.equal(emptyHint.print(), false);
  assert.deepEqual(empty.writes, []);

  const piped = fakeOutput({ isTTY: false });
  const pipedHint = new ResumeHint(piped.output);
  pipedHint.arm(session("01KABC", ["user/input"]));
  assert.equal(pipedHint.print(), false);
  assert.deepEqual(piped.writes, []);

  const unarmed = fakeOutput();
  assert.equal(new ResumeHint(unarmed.output).print(), false);
  assert.deepEqual(unarmed.writes, []);

  const disarmed = fakeOutput();
  const disarmedHint = new ResumeHint(disarmed.output);
  disarmedHint.arm(session("01KABC", ["user/input"]));
  disarmedHint.disarm();
  assert.equal(disarmedHint.print(), false);
  assert.deepEqual(disarmed.writes, []);
});

test("a dead terminal does not turn exit into a crash", () => {
  const broken = fakeOutput({ fail: true });
  const hint = new ResumeHint(broken.output);
  hint.arm(session("01KABC", ["user/input"]));
  assert.equal(hint.print(), false);
});

test("the exit listener is registered once and removable", () => {
  const hint = new ResumeHint(fakeOutput().output);
  const before = process.listenerCount("exit");
  const remove = hint.installOnExit();
  assert.equal(process.listenerCount("exit"), before + 1);
  remove();
  assert.equal(process.listenerCount("exit"), before);
});

test("session ids match exactly or by unique prefix only", () => {
  assert.equal(
    matchSessionChoice(ENTRIES, "01KAAAAAAAAAAAAAAAAAAAAAAB")?.id,
    "01KAAAAAAAAAAAAAAAAAAAAAAB",
  );
  assert.equal(
    matchSessionChoice(ENTRIES, "01KB")?.id,
    "01KBBBBBBBBBBBBBBBBBBBBBBB",
  );
  assert.equal(matchSessionChoice(ENTRIES, "01KA"), null);
  assert.equal(matchSessionChoice(ENTRIES, "zzz"), null);
});

test("resume resolves latest, ids, and an empty argument", async () => {
  const latest = await resolveResumeTarget(ENTRIES, "latest", noSearch);
  assert.equal(latest.kind, "session");
  assert.equal(latest.entry.id, ENTRIES[0].id);

  const byPrefix = await resolveResumeTarget(ENTRIES, " 01KB ", noSearch);
  assert.equal(byPrefix.kind, "session");
  assert.equal(byPrefix.entry.id, ENTRIES[2].id);

  const picker = await resolveResumeTarget(ENTRIES, "", noSearch);
  assert.equal(picker.kind, "choose");
  assert.equal(picker.title, "Resume session");
  assert.deepEqual(
    picker.entries.map((entry) => entry.id),
    ENTRIES.map((entry) => entry.id),
  );

  const single = await resolveResumeTarget([ENTRIES[1]], "", noSearch);
  assert.equal(single.kind, "session");
  assert.equal(single.entry.id, ENTRIES[1].id);

  const none = await resolveResumeTarget([], "latest", noSearch);
  assert.deepEqual(none, {
    kind: "none",
    message: "No sessions in this project.",
  });
});

test("the resume picker is bounded and says how to narrow it", async () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    id: `S${String(index).padStart(3, "0")}`,
    updated_at: "2026-11-23T10:00:00.000Z",
    title: null,
    parent_session_id: null,
  }));
  const picker = await resolveResumeTarget(many, "", noSearch);
  assert.equal(picker.kind, "choose");
  assert.equal(picker.entries.length, 20);
  assert.match(picker.title, /showing 20 of 25; pass text to search/u);
});

test("resume text falls back to search in relevance order", async () => {
  const queries = [];
  const search = async (query) => {
    queries.push(query);
    return query === "login"
      ? [ENTRIES[0].id, ENTRIES[0].id, "unknown-session"]
      : query === "everything"
        ? [ENTRIES[2].id, ENTRIES[0].id]
        : [];
  };
  const one = await resolveResumeTarget(ENTRIES, "login", search);
  assert.equal(one.kind, "session");
  assert.equal(one.entry.id, ENTRIES[0].id);

  const several = await resolveResumeTarget(ENTRIES, "everything", search);
  assert.equal(several.kind, "choose");
  assert.equal(several.title, "Resume matching session");
  assert.deepEqual(
    several.entries.map((entry) => entry.id),
    [ENTRIES[2].id, ENTRIES[0].id],
  );

  const missing = await resolveResumeTarget(ENTRIES, "nothing", search);
  assert.deepEqual(missing, {
    kind: "none",
    message: "No session id, title, or event excerpt matches nothing.",
  });
  // An ambiguous id prefix is not a match, so it is searched as text.
  await resolveResumeTarget(ENTRIES, "01KA", search);
  assert.deepEqual(queries, ["login", "everything", "nothing", "01KA"]);
});

test("resume choice labels show id, time, title, and parent", () => {
  assert.equal(
    resumeChoiceLabel(ENTRIES[1]),
    "01KAAAAAAAAAAAAAAAAAAAAAAB  2026-11-22T10:00:00.000Z  (untitled)  from 01KAAAAAAAAAAAAAAAAAAAAAAA",
  );
});

async function runCli(args, cwd, home) {
  return execFileAsync(process.execPath, [await ensureBuilt(), ...args], {
    cwd,
    env: { ...BASE_ENV, CODEPUNK_HOME: home, NO_COLOR: "1" },
  });
}

test("codepunk resume is documented and refuses unsafe combinations", async () => {
  await withTempDirectory("codepunk-resume-cli-", async (root) => {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: project });

    const help = await runCli(["--help"], project, home);
    assert.match(help.stdout, /codepunk resume \[session-id\|latest\|text\]/u);
    const scoped = await runCli(["resume", "--help"], project, home);
    assert.match(scoped.stdout, /codepunk resume latest/u);
    assert.doesNotMatch(scoped.stdout, /codepunk \[options\]/u);
    const completion = await runCli(["completion", "bash"], project, home);
    assert.match(completion.stdout, /\bresume\b/u);

    for (const [flags, named] of [
      [["--session", "abc"], "--session"],
      [["--continue"], "--continue"],
      [["--fork", "abc"], "--fork"],
      [["--new-session"], "--new-session"],
      [["-p"], "--print"],
    ]) {
      await assert.rejects(
        () => runCli(["resume", ...flags], project, home),
        (error) => {
          assert.equal(error.code, 1);
          assert.match(
            error.stderr,
            new RegExp(`resume cannot be combined with ${named}`, "u"),
          );
          return true;
        },
      );
    }

    // execFile gives the child pipes, not a terminal.
    await assert.rejects(
      () => runCli(["resume", "latest"], project, home),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /resume needs an interactive terminal/u);
        return true;
      },
    );
  });
});
