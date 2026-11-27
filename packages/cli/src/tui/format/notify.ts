import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function notify(
  context: Pick<ExtensionContext, "ui">,
  message: string,
): Promise<void> {
  context.ui.notify(message, "info");
}
