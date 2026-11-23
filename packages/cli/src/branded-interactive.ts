import { InteractiveMode } from "@earendil-works/pi-coding-agent";

const FORBIDDEN_TUI_BRAND_PATTERN = /\bPi\b|pi update|pi\.dev/u;

export function assertUserVisibleTuiText(text: string): void {
  if (FORBIDDEN_TUI_BRAND_PATTERN.test(text)) {
    throw new Error(
      "user-visible TUI output contains an internal engine brand",
    );
  }
}

export class BrandedInteractiveMode extends InteractiveMode {
  override showNewVersionNotification(): void {
    assertUserVisibleTuiText("Update Available");
  }

  override showPackageUpdateNotification(packages: readonly string[]): void {
    assertUserVisibleTuiText(packages.join("\n"));
  }
}
