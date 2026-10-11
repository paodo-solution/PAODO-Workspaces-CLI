import { connect } from "../../client.mjs";
import { receipt } from "../../output.mjs";
import { fileTree, filePath, spaceRoot } from "./route.mjs";

/**
 * The app's delete receipts as one answer: every path they named, and how many there were in total.
 *
 * The app already caps its own list, because a delete of a large tree would otherwise reply with a few
 * hundred thousand paths — so `removedCount` is the number and `removed` is as much of it as is worth
 * printing. Emptying a workspace or a drive is N of those replies, and summing them here is what keeps
 * one delete and a hundred of them the same shape to read.
 *
 * The note is composed rather than relayed for that same reason: the app can only speak for the call it
 * answered, and a merged list is short in a way no single response saw. Composed from the two numbers,
 * so it cannot say anything the receipt above it does not already show.
 */
function summarize(receipts) {
  const removed = receipts.flatMap((r) => r?.removed ?? []);
  const removedCount = receipts.reduce((total, r) => total + (r?.removedCount ?? 0), 0);
  return {
    removed,
    removedCount,
    ...(removed.length < removedCount
      ? { note: `${removed.length} of ${removedCount} removed paths listed` }
      : {}),
  };
}

export default function (space) {
  async function run([reference, spacePath]) {
    const id = space.requireId(reference);
    const client = connect();
    const normalized = spaceRoot(spacePath);
    const root = normalized === undefined || normalized === ".";

    if (!root) {
      // Summarized even for one call, not relayed, so removing a file and emptying the whole space answer
      // in the same shape. They are the same act at two scales, and a caller that had to branch on which
      // keys came back was branching on how much it happened to delete.
      const removal = await client.json(filePath(space, id, "content", { path: normalized }), { method: "DELETE" });
      receipt({ [space.subject]: id }, summarize([removal]));
      return;
    }

    // "Empty it" is the UI's select-all-and-delete, issued as one delete per top-level entry. It stays a
    // client-side loop precisely so the server keeps one definition of a delete.
    // The one-level listing is exactly the set this needs: deleting a top-level entry takes its subtree
    // with it, so anything below would be a path fetched to be discarded.
    // Addressed by `path`, which at the top level is the same string as `name` but is the field the
    // route actually accepts — so this client reads only the two the listing keeps.
    //
    // Listed again after each round rather than once, because that listing is capped (the app's ceiling,
    // see route.mjs): one pass over one page would empty only the first page of entries and report `ok` for the
    // whole root, which is the one answer a delete must never give. Each round strictly shrinks the
    // root — a delete that did not remove its path throws rather than returning — so this terminates,
    // and it holds one page at a time however large the root is.
    const removals = [];
    for (;;) {
      const { tree } = await fileTree(client, space, id);
      const paths = (tree ?? []).map((entry) => entry?.path).filter(Boolean);
      if (paths.length === 0) break;
      for (const path of paths) {
        removals.push(await client.json(filePath(space, id, "content", { path }), { method: "DELETE" }));
      }
    }
    // No `root: true`. `ok` says it worked and `removed` says what went; a flag saying which of the two
    // code paths produced the answer is this command's shape leaking into its receipt.
    receipt({ [space.subject]: id }, summarize(removals));
  }

  return { min: 2, max: 2, run };
}
