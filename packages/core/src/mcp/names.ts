export const LIST_MCP_RESOURCES_TOOL = "list_mcp_resources";
export const LIST_MCP_RESOURCE_TEMPLATES_TOOL = "list_mcp_resource_templates";
export const READ_MCP_RESOURCE_TOOL = "read_mcp_resource";

export const MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_MCP_RESOURCES_TOOL,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL,
  READ_MCP_RESOURCE_TOOL,
]);

export function isMcpResourceTool(name: string): boolean {
  return MCP_RESOURCE_TOOL_NAMES.has(name);
}
