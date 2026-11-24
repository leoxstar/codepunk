import type {
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { planRenderers } from "./plan.ts";
import { searchRenderers } from "./search.ts";
import { todoRenderers } from "./todo.ts";

export { planRenderers, searchRenderers, todoRenderers };

const CODEPUNK_RENDERERS: Readonly<Record<string, ToolRenderers>> = {
  search: searchRenderers,
  plan: planRenderers,
  todo: todoRenderers,
};

export function codepunkToolRendererResolver(): ToolRendererResolver {
  return (toolName, next) =>
    Object.hasOwn(CODEPUNK_RENDERERS, toolName)
      ? CODEPUNK_RENDERERS[toolName]
      : next();
}
