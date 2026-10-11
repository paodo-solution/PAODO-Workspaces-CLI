import { connect } from "../../client.mjs";
import { receipt } from "../../output.mjs";
import { filePath, spaceRoot } from "./route.mjs";

export default function (space) {
  async function run([reference, spacePath]) {
    const id = space.requireId(reference);
    // The root is sent as ".", the app's own spelling of it, so the app is the one that refuses it: a
    // delete names one entry, and that rule and its wording are the app's.
    const path = spaceRoot(spacePath) ?? ".";

    // The app already caps its own list, because a delete of a large tree would otherwise reply with a
    // few hundred thousand paths — so `removedCount` is the number, `removed` is as much of it as is
    // worth printing, and `note` is the app saying so when the list was cut short.
    const removal = await connect().json(filePath(space, id, "content", { path }), { method: "DELETE" });
    receipt(
      { [space.subject]: id },
      {
        removed: removal?.removed ?? [],
        removedCount: removal?.removedCount ?? 0,
        ...(removal?.note ? { note: removal.note } : {}),
      },
    );
  }

  return { min: 2, max: 2, run };
}
