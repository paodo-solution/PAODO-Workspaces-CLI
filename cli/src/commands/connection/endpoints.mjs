// The vocabulary a connection's ends are printed in, shared by `connection ls` and `connection create`.
// Which pairs may be connected, and what an id is connected to, are the app's answers, not anything here.
import { Note } from "../../output.mjs";

/**
 * A row's ends, each as two fields: the name to read, and the id the next command takes. An end the
 * app could not name — its id answers to nothing now — reads `(not found)` beside the id it still has.
 */
export function namedEnds(ends) {
  return Object.fromEntries(
    Object.entries(ends).flatMap(([role, end]) => [
      [role, end?.name ?? new Note("(not found)")],
      [`${role}Id`, end?.id],
    ]),
  );
}
