export class UsageError extends Error {
  override name = "UsageError";
}

export class CommandCancelledError extends Error {
  override name = "CommandCancelledError";
}
