// The CLI consumes PAODO's public wire contract without importing app source: this directory will
// become its own repository. Local failures use the same shape and their own clearly scoped codes.
export class CliError extends Error {
  constructor(code, message, { details, requestId, publicBody, hint } = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.publicBody = publicBody;
    // The CLI's own remark beside the app's answer, never a rewording of it.
    this.hint = hint;
  }
}

export function usageError(message) {
  return new CliError("CLI_USAGE_ERROR", message);
}

export function failureBody(error) {
  const known = error instanceof CliError;
  const hint = known && error.hint ? { hint: error.hint } : {};
  if (known && error.publicBody) return { ...error.publicBody, ...hint };
  return {
    ok: false,
    code: known ? error.code : "CLI_ERROR",
    error: error instanceof Error ? error.message : String(error),
    ...(known && error.details ? { details: error.details } : {}),
    ...(known && error.requestId ? { requestId: error.requestId } : {}),
    ...hint,
  };
}
