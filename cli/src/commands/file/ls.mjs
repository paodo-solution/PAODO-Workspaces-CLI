import { connect } from "../../client.mjs";
import { receipt } from "../../output.mjs";
import { fileTree } from "./route.mjs";

/**
 * Every entry the route named, one per element, a directory marked by a trailing slash on its path.
 *
 * The slash is what makes a one-level listing navigable rather than partial: it is the difference
 * between "this is all there is" and "there is more here, list it", and the path it is attached to is
 * the argument that lists it.
 *
 * The route answers with the nesting the file panel renders, and that is the right shape for a panel:
 * a directory owns its children, so a row can collapse and a click can select a subtree. A caller
 * reading this listing to decide what to read or delete next wants the opposite, and wants nothing in
 * it that it would have to skip past. So all three of the tree's redundancies go:
 *
 *   - `name` is the last segment of `path`, stored a second time in the same object.
 *   - `type` is a field per entry to say what one character says, and the app strips that character
 *     from any path handed back to it (lib/files/relpath.ts), so the mark costs nothing downstream —
 *     a listed directory is still a valid argument to cat, get and rm.
 *   - `children` exists to let a reader rebuild path prefixes that `path` already spells out in full,
 *     so flattening loses none of it. Empty at one level, and still flattened rather than assumed
 *     empty: a listing that quietly dropped whatever nesting it was served would be the one failure
 *     this format cannot show — a missing entry looks exactly like a file that is not there.
 *
 * What does not go is `lines`, which is why an entry is an object rather than the bare path string it
 * used to be. It is the unit `cat --offset` and `--limit` are counted in, so having it here is the
 * difference between asking for a window and discovering a file's length by running off the end of it.
 * A directory has none, and neither does a file with no lines to count.
 *
 * A directory gets `contains` for the same reason a file gets `lines`: it is what the caller needs to
 * decide whether to go in. The trailing slash says there is more here, and nothing else in a one-level
 * listing distinguishes a folder holding one note from one holding fourteen thousand files — the
 * difference is entirely below the level being listed. The unit is written out because "contains" alone
 * does not say of what, and a folder with nothing in it says nothing rather than "0 files", so the
 * counts that appear are all of them worth reading.
 *
 * Done here rather than at the route because nothing is lost doing it here — every node already
 * carries its full wire path and its kind — while doing it there would mean a second response shape
 * to define and test, and would take from the panel the one thing it cannot render without.
 */
function contains(files) {
  return files ? { contains: `${files} file${files === 1 ? "" : "s"}` } : {};
}

function flatEntries(nodes) {
  return (nodes ?? []).flatMap((node) =>
    node.type === "directory"
      ? [{ path: `${node.path}/`, ...contains(node.files) }, ...flatEntries(node.children)]
      : [{ path: node.path, ...(node.lines === undefined ? {} : { lines: node.lines }) }],
  );
}

/**
 * Said when the route stopped at the ceiling, and it has to say two things rather than one.
 *
 * That the set is partial is the obvious half. That it is *arbitrary* is the half a reader will
 * otherwise get wrong: the sort below runs after the cut, so these are the first entries up to the app's ceiling
 * the filesystem happened to return and then sorted — not the alphabetically first ones. A caller told
 * only "truncated" reasonably concludes it has seen everything up to some letter, and goes looking for
 * the rest past it.
 *
 * Naming the next move matters as much: with no way to ask for entry 1001, a caller that is not told
 * to narrow the path has been handed a dead end. Same wording as the agent's drive_ls, which reaches
 * the same ceiling from the other side of the app.
 */
function truncation({ truncated, limit }) {
  if (!truncated) return {};
  // The number is the one the app says it stopped at; an answer without one is still said to be partial.
  const [at, first] = Number.isInteger(limit) ? [` at ${limit} entries`, `the first ${limit}`] : ["", "the first"];
  return {
    note:
      `listing truncated${at} — this directory holds more. These are ${first} the filesystem ` +
      `returned, in no particular order, then sorted. Name a directory inside it to see the rest.`,
  };
}

export default function (space) {
  async function run([reference, spacePath]) {
    const id = space.requireId(reference);
    const listing = await fileTree(connect(), space, id, spacePath, { measure: true, count: true });
    // The default string sort, so the order comes out of the bytes rather than the machine's locale.
    const entries = flatEntries(listing.tree).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    // After `entries`, so the reader meets the listing before the caveat about it — and only ever when
    // there is a caveat, since a whole listing carries no note at all.
    receipt({ [space.subject]: id }, { entries, ...truncation(listing) });
  }

  return { min: 1, max: 2, run };
}
