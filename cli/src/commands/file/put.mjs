import { connect } from "../../client.mjs";
import { collectLocalTransfer, defaultDestination, packLocalTransfer } from "../../file-transfer.mjs";
import { receipt } from "../../output.mjs";
import { filePath, spaceRoot } from "./route.mjs";

/** This machine -> the named space. The mirror of get, so the local path is the one that is read. */
export default function (space) {
  async function run([reference, localSource, suppliedDest]) {
    // Before the local walk, so an unusable id is refused without first reading the filesystem.
    const id = space.requireId(reference);
    const { items } = await collectLocalTransfer(localSource);
    const dest = spaceRoot(suppliedDest) ?? defaultDestination(localSource);
    // The app's receipt, relayed under the envelope. It already names what it created, overwrote and
    // refused, so there is no second exclusion list here to merge into it.
    const pushed = await connect().json(filePath(space, id, "transfer", { dest }), {
      method: "PUT",
      body: packLocalTransfer(items),
      contentType: "application/x-tar",
    });
    const { ok: _ok, created, overwritten, ignored, ...rest } = pushed;
    // `destination` because the three lists below are paths, and a push and a pull name paths in
    // different spaces — the workspace's or the drive's going this way, local coming back. The lists are
    // identical in name and meaning either way, so without this the one thing telling them apart would
    // be which command the caller remembers running.
    receipt({ [space.subject]: id }, { destination: space.noun, created, overwritten, ignored, ...rest });
  }

  return { min: 2, max: 3, run };
}
