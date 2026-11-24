import {
  isFallbackModel,
  setConfiguredModel,
  type CodepunkRuntime,
} from "codepunk-core";

export async function persistPiDefaultModel(
  runtime: CodepunkRuntime,
  notify?: (message: string, level: "info" | "warning") => void,
): Promise<boolean> {
  const settings = runtime.host.services.settingsManager;
  const provider = settings.getDefaultProvider();
  const id = settings.getDefaultModel();
  if (provider === undefined || id === undefined) {
    return false;
  }
  if (isFallbackModel({ provider, id })) {
    return false;
  }
  if (
    runtime.config.model.provider === provider &&
    runtime.config.model.id === id
  ) {
    return false;
  }
  try {
    await setConfiguredModel(runtime.paths, runtime.config, provider, id);
    notify?.(
      `model set to ${provider}/${id}\nconfig: ${runtime.paths.home}/config.toml`,
      "info",
    );
    return true;
  } catch (error) {
    notify?.(
      `model default ${provider}/${id} is active in Pi but was not saved: ${
        error instanceof Error ? error.message : String(error)
      }`,
      "warning",
    );
    return false;
  }
}
