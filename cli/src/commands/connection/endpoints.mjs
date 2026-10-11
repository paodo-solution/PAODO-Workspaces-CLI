// What `connection ls` reads its rows with: the two lists that name an id, and the vocabulary an
// edge's ends are printed in. Which pairs may be connected is the app's rule, not anything here.
import { CliError } from "../../errors.mjs";
import { Note } from "../../output.mjs";

export function requireArray(value, what) {
  if (!Array.isArray(value)) throw new CliError("INVALID_RESPONSE", `PAODO returned an invalid ${what}.`);
  return value;
}

export function namesById(items) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item.name]));
}

/** One endpoint, as two fields: the name to read, and the id the next command takes. */
export function endpoint(field, id, names) {
  return { [field]: names.has(id) ? names.get(id) : new Note("(not found)"), [`${field}Id`]: id };
}
