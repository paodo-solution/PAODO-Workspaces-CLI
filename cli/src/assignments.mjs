// `field=value` arguments into a request body, shared by every `set` command so they parse one way.
import { usageError } from "./errors.mjs";

/**
 * Wire encoding, not validation. A value its field's declared type cannot hold travels as the string it
 * arrived as, and so do unknown fields, because the app's shared operation owns the authoritative
 * field/type/range rules and answers with the same error the UI receives. An int is plain decimal
 * digits only, so `0x10` or `1e2` reach the app as text and are refused, never read as 16 or 100.
 */
function encode(type, value) {
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (type === "int" && /^-?\d+$/.test(value)) return Number(value);
  return value;
}

/**
 * Syntax only, so a malformed argument is refused before any request is made.
 *
 * @param assignments the `field=value` arguments, in the order given
 * @param shorthands bare words a caller may type instead, each → the assignment to suggest in the refusal
 * @returns each named field once, its value still the text that was typed
 */
export function parseAssignments(assignments, shorthands = {}) {
  const typed = Object.create(null);
  for (const assignment of assignments) {
    const equals = assignment.indexOf("=");
    if (equals < 1) {
      const hint = Object.hasOwn(shorthands, assignment) ? ` Did you mean ${shorthands[assignment]}?` : "";
      throw usageError(`Expected field=value, got "${assignment}".${hint}`);
    }
    const field = assignment.slice(0, equals);
    if (field in typed) throw usageError(`Field "${field}" was supplied more than once.`);
    typed[field] = assignment.slice(equals + 1);
  }
  return typed;
}

/**
 * @param typed parseAssignments' result
 * @param fields the app's contract for the resource (contract.mjs): name → `{ type }`
 * @returns the request body, each value encoded as its field's type
 */
export function encodeAssignments(typed, fields) {
  const body = Object.create(null);
  for (const [field, value] of Object.entries(typed)) {
    body[field] = encode(Object.hasOwn(fields, field) ? fields[field]?.type : undefined, value);
  }
  return body;
}
