import {
  GoalEventDataSchema,
  validateSchema,
  type GoalAction,
  type GoalEventData,
  type GoalState,
  type SessionEvent,
} from "codepunk-protocol";
import { canonicalJson, createUlid, sha256Text } from "../platform/hash.ts";
import type { SessionStore } from "./index.ts";

export class GoalCorruptError extends Error {
  readonly code = "goal.corrupt";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoalCorruptError";
  }
}

export class GoalTransitionError extends Error {
  readonly code = "goal.invalid_transition";

  constructor(message: string) {
    super(message);
    this.name = "GoalTransitionError";
  }
}

export interface GoalControllerOptions {
  now?: () => Date;
}

interface GoalRecord {
  action: GoalAction;
  data: GoalEventData;
}

const goalQueues = new WeakMap<SessionStore, Promise<void>>();

function enqueueGoalOperation<T>(
  store: SessionStore,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = goalQueues.get(store) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  goalQueues.set(
    store,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

export class GoalController {
  readonly #store: SessionStore;
  readonly #now: () => Date;

  constructor(store: SessionStore, options: GoalControllerOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
  }

  get state(): GoalState | null {
    return readGoalState(this.#store.allEvents);
  }

  async set(objective: string): Promise<SessionEvent> {
    return enqueueGoalOperation(this.#store, async () => {
      const previous = latestGoalEvent(this.#store.allEvents);
      if (previous !== null && previous.data.action !== "clear") {
        throw new GoalTransitionError(
          "goal set requires no active or paused goal",
        );
      }
      const timestamp = this.#now().toISOString();
      return appendGoalEventSerialized(this.#store, {
        action: "set",
        previous_sha256: previous?.data.event_sha256 ?? null,
        goal: {
          goal_id: createUlid(this.#now()),
          objective,
          status: "active",
          revision: 1,
          created_at: timestamp,
          updated_at: timestamp,
        },
      });
    });
  }

  async pause(): Promise<SessionEvent> {
    return enqueueGoalOperation(this.#store, async () => {
      const state = this.requireState("pause", "active");
      return this.appendTransition("pause", {
        ...state,
        status: "paused",
        revision: state.revision + 1,
        updated_at: this.#now().toISOString(),
      });
    });
  }

  async resume(): Promise<SessionEvent> {
    return enqueueGoalOperation(this.#store, async () => {
      const state = this.requireState("resume", "paused");
      return this.appendTransition("resume", {
        ...state,
        status: "active",
        revision: state.revision + 1,
        updated_at: this.#now().toISOString(),
      });
    });
  }

  async clear(): Promise<SessionEvent> {
    return enqueueGoalOperation(this.#store, async () => {
      const state = this.state;
      if (state === null || state.status === "cleared") {
        throw new GoalTransitionError(
          "goal clear requires an active or paused goal",
        );
      }
      return this.appendTransition("clear", {
        ...state,
        status: "cleared",
        updated_at: this.#now().toISOString(),
      });
    });
  }

  async update(
    action: Extract<GoalAction, "pause" | "resume" | "clear">,
    goal: GoalState,
  ): Promise<SessionEvent> {
    return enqueueGoalOperation(this.#store, async () =>
      this.appendTransition(action, goal),
    );
  }

  requireState(action: GoalAction, status: GoalState["status"]): GoalState {
    const state = this.state;
    if (state === null || state.status !== status) {
      throw new GoalTransitionError(`goal ${action} requires a ${status} goal`);
    }
    return state;
  }

  private async appendTransition(
    action: Extract<GoalAction, "pause" | "resume" | "clear">,
    goal: GoalState,
  ): Promise<SessionEvent> {
    return appendGoalEventSerialized(this.#store, {
      action,
      previous_sha256:
        latestGoalEvent(this.#store.allEvents)?.data.event_sha256 ?? null,
      goal,
    });
  }
}

export async function appendGoalEvent(
  store: SessionStore,
  event: Omit<GoalEventData, "event_sha256">,
): Promise<SessionEvent> {
  return enqueueGoalOperation(store, async () =>
    appendGoalEventSerialized(store, event),
  );
}

async function appendGoalEventSerialized(
  store: SessionStore,
  event: Omit<GoalEventData, "event_sha256">,
): Promise<SessionEvent> {
  const previous = latestGoalEvent(store.allEvents);
  const data = withEventHash(event);
  validateChain(previous, data);
  return store.append("goal/update", data);
}

export function readGoalState(
  events: readonly SessionEvent[],
): GoalState | null {
  const previous = projectGoalEvents(events);
  if (previous === null || previous.data.goal.status === "cleared") {
    return null;
  }
  return previous.data.goal;
}

export function goalModelContext(
  events: readonly SessionEvent[],
): string | null {
  const state = readGoalState(events);
  if (state === null || state.status !== "active") {
    return null;
  }
  return ["Goal (untrusted data):", JSON.stringify(state, null, 2)].join("\n");
}

function withEventHash(
  event: Omit<GoalEventData, "event_sha256">,
): GoalEventData {
  return {
    ...event,
    event_sha256: sha256Text(
      canonicalJson({
        action: event.action,
        previous_sha256: event.previous_sha256,
        goal: event.goal,
      }),
    ),
  };
}

function projectGoalEvents(events: readonly SessionEvent[]): GoalRecord | null {
  let previous: GoalRecord | null = null;
  for (const event of events) {
    if (event.kind !== "goal/update") {
      continue;
    }
    const data = validateGoalData(event);
    validateChain(previous, data);
    previous = { action: data.action, data };
  }
  return previous;
}

function latestGoalEvent(events: readonly SessionEvent[]): GoalRecord | null {
  let previous: GoalRecord | null = null;
  for (const event of events) {
    if (event.kind !== "goal/update") {
      continue;
    }
    const data = validateGoalData(event);
    validateChain(previous, data);
    previous = { action: data.action, data };
  }
  return previous;
}

function validateGoalData(event: SessionEvent): GoalEventData {
  const validation = validateSchema(GoalEventDataSchema, event.data);
  if (!validation.ok) {
    throw new GoalCorruptError(
      `goal event ${event.seq} has invalid data: ${validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`,
    );
  }
  const data = event.data as GoalEventData;
  const expectedHash = sha256Text(
    canonicalJson({
      action: data.action,
      previous_sha256: data.previous_sha256,
      goal: data.goal,
    }),
  );
  if (data.event_sha256 !== expectedHash) {
    throw new GoalCorruptError(
      `goal event ${event.seq} has an invalid event_sha256`,
    );
  }
  return data;
}

function validateChain(previous: GoalRecord | null, data: GoalEventData): void {
  if (previous === null) {
    if (data.action !== "set" || data.previous_sha256 !== null) {
      throw new GoalCorruptError(
        "the first goal event must be set with a null previous_sha256",
      );
    }
    if (data.goal.revision !== 1) {
      throw new GoalCorruptError("the first goal revision must be 1");
    }
    if (data.goal.status !== "active") {
      throw new GoalCorruptError("goal set must produce an active goal");
    }
    return;
  }

  if (data.previous_sha256 !== previous.data.event_sha256) {
    throw new GoalCorruptError(
      `goal event has a broken previous_sha256 chain at action "${data.action}"`,
    );
  }

  if (data.action === "set") {
    if (previous.data.action !== "clear") {
      throw new GoalCorruptError(
        "goal set cannot follow an active or paused goal",
      );
    }
    if (data.goal.revision !== 1) {
      throw new GoalCorruptError("a reopened goal revision must be 1");
    }
    if (data.goal.status !== "active") {
      throw new GoalCorruptError("goal set must produce an active goal");
    }
    return;
  }

  if (
    data.goal.goal_id !== previous.data.goal.goal_id ||
    data.goal.created_at !== previous.data.goal.created_at ||
    data.goal.objective !== previous.data.goal.objective
  ) {
    throw new GoalCorruptError(
      `goal event has inconsistent goal identity or objective at action "${data.action}"`,
    );
  }

  const expectedStatus =
    data.action === "pause"
      ? "paused"
      : data.action === "resume"
        ? "active"
        : "cleared";
  if (data.goal.status !== expectedStatus) {
    throw new GoalCorruptError(
      `goal ${data.action} must produce status ${expectedStatus}`,
    );
  }

  const expectedRevision =
    data.action === "clear"
      ? previous.data.goal.revision
      : previous.data.goal.revision + 1;
  if (data.goal.revision !== expectedRevision) {
    throw new GoalCorruptError(
      `goal event has a non-contiguous revision at action "${data.action}"`,
    );
  }

  if (data.action === "pause" && previous.data.goal.status !== "active") {
    throw new GoalCorruptError("goal pause requires an active goal");
  }
  if (data.action === "resume" && previous.data.goal.status !== "paused") {
    throw new GoalCorruptError("goal resume requires a paused goal");
  }
  if (data.action === "clear" && previous.data.goal.status === "cleared") {
    throw new GoalCorruptError("goal clear requires an active or paused goal");
  }
}
