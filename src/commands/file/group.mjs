// The file group, assembled once and mounted under each noun that has files: `paodo workspace file ls`
// and `paodo drive file ls` are the same five commands over two different directories.
//
// This is why the five files beside it export a factory rather than a command. A workspace and a drive
// sit behind the same routes, obey the same path rules and answer with the same receipts — the only
// things that differ are which collection a URL names and which id a receipt carries, and both of those
// are the `space` below. Written as two command groups instead, every rule in the group would have had
// two copies to keep in step, and the first one to drift would do it silently: a `put` that defaulted
// its destination differently on a drive is a successful transfer to the wrong place.
//
// The noun comes first for the reason it does everywhere else in this tree — and here it also removes a
// question the caller would otherwise have to answer twice. A workspace id and a drive id are both
// random UUIDs, so an id alone cannot say which space it belongs to; the command word says it, which
// means there is no id to mistype into the wrong space and no prefix to remember.
import { drivePath, requireDriveId, requireWorkspaceId, workspacePath } from "../../client.mjs";
import cat from "./cat.mjs";
import get from "./get.mjs";
import ls from "./ls.mjs";
import put from "./put.mjs";
import rm from "./rm.mjs";

/**
 * One path space the file commands act on.
 *
 * `noun` is the word a caller typed and the one a receipt says back — `destination: "drive"` on a push,
 * so a transfer's three lists name the side of the boundary they belong to. `subject` is the receipt
 * envelope's key, which is what tells a reader which kind of thing the command touched (see receipt in
 * output.mjs). `resource` builds the URL; `requireId` refuses an empty one before it becomes a URL that
 * is a different route rather than a missing resource.
 */
function space(noun, resource, requireId) {
  return { noun, subject: `${noun}Id`, resource, requireId };
}

export const WORKSPACE = space("workspace", workspacePath, requireWorkspaceId);
export const DRIVE = space("drive", drivePath, requireDriveId);

export function fileGroup(target) {
  return {
    commands: {
      ls: ls(target),
      cat: cat(target),
      get: get(target),
      put: put(target),
      rm: rm(target),
    },
  };
}
