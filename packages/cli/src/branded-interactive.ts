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
    // Suppress host update banners; `codepunk upgrade --check` owns product updates.
  }

  override showPackageUpdateNotification(_packages: readonly string[]): void {
    // Suppress internal host package notifications without throwing on package names.
  }
}
