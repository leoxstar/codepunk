import type { TaskSpec } from "@codepunk/protocol";
import { createTaskSpec, type TaskSpecInput } from "./spec.ts";

export const REQUIREMENT_ANGLES = [
  "product",
  "engineering",
  "security",
  "cost",
] as const;

export type RequirementAngle = (typeof REQUIREMENT_ANGLES)[number];

export interface RequirementReview {
  perspective: RequirementAngle;
  options: string[];
  assumptions: string[];
  disagreements: string[];
}

export interface RequirementReviewer {
  id: string;
  perspective: RequirementAngle;
  tools: readonly string[];
  review(request: string): Promise<RequirementReview>;
}

export interface RequirementChair {
  actor: string;
  human: boolean;
  tty: boolean;
  decide(reviews: readonly RequirementReview[]): Promise<{
    confirmed: boolean;
    summary: string;
    task: Omit<TaskSpecInput, "now">;
  }>;
}

export interface RequirementTeamResult {
  request: string;
  reviews: RequirementReview[];
  summary: string;
  task_spec: TaskSpec;
  spec_sha256: string;
  chair: string;
}

function reviewerIssue(reviewer: RequirementReviewer): string | null {
  if (!["read", "search"].includes(reviewer.tools[0] ?? "")) {
    return `reviewer ${reviewer.id} has no read-only tool`;
  }
  if (reviewer.tools.some((tool) => !["read", "search"].includes(tool))) {
    return `reviewer ${reviewer.id} has a mutating tool`;
  }
  return null;
}

export async function runRequirementTeam(input: {
  request: string;
  reviewers: readonly RequirementReviewer[];
  chair: RequirementChair;
  now?: () => Date;
}): Promise<RequirementTeamResult> {
  if (input.reviewers.length < 3 || input.reviewers.length > 4) {
    throw new Error("RequirementTeam requires 3 to 4 reviewers");
  }
  if (!input.chair.human || !input.chair.tty) {
    throw new Error("RequirementTeam chair must be a local human TTY action");
  }
  if (input.chair.actor.trim().length === 0) {
    throw new Error("RequirementTeam chair actor is missing");
  }
  const ids = new Set<string>();
  const perspectives = new Set<RequirementAngle>();
  for (const reviewer of input.reviewers) {
    if (ids.has(reviewer.id)) {
      throw new Error(`duplicate reviewer id ${reviewer.id}`);
    }
    ids.add(reviewer.id);
    if (perspectives.has(reviewer.perspective)) {
      throw new Error(`duplicate reviewer perspective ${reviewer.perspective}`);
    }
    perspectives.add(reviewer.perspective);
    const issue = reviewerIssue(reviewer);
    if (issue !== null) {
      throw new Error(issue);
    }
  }
  const reviews = await Promise.all(
    input.reviewers.map((reviewer) => reviewer.review(input.request)),
  );
  for (let index = 0; index < reviews.length; index += 1) {
    if (reviews[index]!.perspective !== input.reviewers[index]!.perspective) {
      throw new Error("reviewer returned a different perspective");
    }
  }
  const decision = await input.chair.decide(reviews);
  if (!decision.confirmed) {
    throw new Error("human chair did not confirm the requirement");
  }
  const spec = createTaskSpec({
    ...decision.task,
    taskId: decision.task.taskId,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    request: input.request,
    reviews,
    summary: decision.summary,
    task_spec: spec,
    spec_sha256: spec.spec_sha256,
    chair: input.chair.actor,
  };
}
