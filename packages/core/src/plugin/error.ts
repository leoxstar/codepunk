export class PluginError extends Error {
  readonly code: string;

  constructor(message: string, code = "plugin.error") {
    super(message);
    this.name = "PluginError";
    this.code = code;
  }
}
