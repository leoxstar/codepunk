export {
  DEFAULT_PROTECTED_PATHS,
  assertTaskSpecImmutable,
  createTaskSpec,
  type TaskSpecInput,
} from "./spec.ts";
export {
  TASK_STATES,
  TaskGraph,
  type DeliveryTask,
  type TaskState,
} from "./graph.ts";
export {
  assertLinkedWorktree,
  createDetachedWorktree,
  discardWorktree,
  freezeWorktree,
  removeMergedWorktree,
  type CreateWorktreeOptions,
  type FreezeWorktreeOptions,
  type FrozenWorktree,
  type Worktree,
} from "./worktree.ts";
export {
  createHandoff,
  handoffArtifactPath,
  treeFileHash,
  writeHandoff,
  type CreateHandoffOptions,
} from "./handoff.ts";
export {
  mergeHandoff,
  pathCoveredBySet,
  pathIntersectsProtected,
  verifyPostMerge,
  type MergeOptions,
  type PostMergeRun,
  type PostMergeVerification,
} from "./merge.ts";
