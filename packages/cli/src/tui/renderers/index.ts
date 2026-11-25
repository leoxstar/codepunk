import type {
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { askUserRenderers } from "./ask-user.ts";
import { memorySearchRenderers } from "./memory.ts";
import { planRenderers } from "./plan.ts";
import { searchRenderers } from "./search.ts";
import { subagentRenderers } from "./subagent.ts";
import { todoRenderers } from "./todo.ts";
import { webFetchRenderers, webSearchRenderers } from "./web.ts";

export {
  askUserRenderers,
  memorySearchRenderers,
  planRenderers,
  searchRenderers,
  subagentRenderers,
  todoRenderers,
  webFetchRenderers,
  webSearchRenderers,
};

const CODEPUNK_RENDERERS: Readonly<Record<string, ToolRenderers>> = {
  search: searchRenderers,
  plan: planRenderers,
  todo: todoRenderers,
  web_fetch: webFetchRenderers,
  web_search: webSearchRenderers,
  ask_user: askUserRenderers,
  subagent: subagentRenderers,
  memory_search: memorySearchRenderers,
};

export function codepunkToolRendererResolver(): ToolRendererResolver {
  return (toolName, next) =>
    Object.hasOwn(CODEPUNK_RENDERERS, toolName)
      ? CODEPUNK_RENDERERS[toolName]
      : next();
}
