// What the app says about itself (GET /api/contract): the fields each `set` accepts, its channels, its
// limits, its vocabularies and what its replies mean. Read when needed rather than restated here: a copy
// is how a rule ends up true in the app and stale in the CLI.
import { connect } from "./client.mjs";
import { CliError } from "./errors.mjs";

/** How an app from before a route answers for it: not one the CLI token may call, or not there at all. */
const UNPUBLISHED = new Set(["FORBIDDEN", "CLI_HTTP_FORBIDDEN", "CLI_HTTP_NOT_FOUND"]);

/**
 * Rethrows `error`, as CLI_APP_TOO_OLD when it is the refusal an older app gives for a route this CLI
 * needs. `what` finishes "This PAODO app does not …", so the caller learns which side to update.
 */
export function rethrowUnpublished(error, what) {
  if (!(error instanceof CliError) || !UNPUBLISHED.has(error.code)) throw error;
  throw new CliError(
    "CLI_APP_TOO_OLD",
    `This PAODO app does not ${what}, which this CLI relies on. Update the app, or use the CLI release that matches it.`,
    { details: { appCode: error.code }, requestId: error.requestId },
  );
}

let reading;

/** The whole contract, read once per process however many commands and help lines ask for a part. */
function contract() {
  reading ??= connect()
    .json("/api/contract")
    .catch((error) => rethrowUnpublished(error, "publish its contract (GET /api/contract)"));
  return reading;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One named part of a section, refused by name when the app does not publish it. */
async function part(section, name) {
  const value = (await contract())?.[section]?.[name];
  if (value === undefined || value === null) {
    throw new CliError("INVALID_RESPONSE", `PAODO's contract does not publish ${section}.${name}.`);
  }
  return value;
}

/**
 * @param resource "workspace", "schedule" or "drive"
 * @returns field name → `{ type, values?, rule? }`, the app's own list
 */
export async function contractFields(resource) {
  const fields = await part("fields", resource);
  if (!isObject(fields)) throw new CliError("INVALID_RESPONSE", `PAODO's contract does not describe ${resource} fields.`);
  return fields;
}

/** The word a caller names a credential channel by → its route segment. */
export async function channels() {
  const published = (await contract())?.channels;
  if (!isObject(published)) throw new CliError("INVALID_RESPONSE", "PAODO's contract does not publish its channels.");
  return published;
}

/** One of the app's numbers, e.g. `listingEntries`. */
export function limit(name) {
  return part("limits", name);
}

/** The app's sentences about one resource's reply fields and behaviours: key → sentence. */
export function description(resource) {
  return part("describe", resource);
}

/** One field as `--help` prints it: its accepted values or its type, then the app's rule in words. */
function line(field) {
  if (!isObject(field)) return String(field);
  const { type, values, rule } = field;
  const kind = Array.isArray(values) && values.length ? values.join("|") : type === "boolean" ? "true|false" : type;
  return [kind, rule].filter(Boolean).join(", ");
}

/**
 * A help value only the app can give, as the function help.mjs stores and main.mjs awaits. A failure to
 * read it is printed in its place, not thrown: the rest of the help is the CLI's own and still true,
 * and a caller with no connection yet needs it most.
 */
export function fromApp(read) {
  return async () => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      return `unavailable — the app owns this and it could not be read: ${error.message}`;
    }
  };
}

/** The `fields` block of a `set --help`. */
export function describeFields(resource) {
  return fromApp(async () => {
    const fields = await contractFields(resource);
    return Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, line(field)]));
  });
}
