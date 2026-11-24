import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export async function notify(
  context: ExtensionCommandContext,
  message: string,
): Promise<void> {
  context.ui.notify(message, "info");
}
