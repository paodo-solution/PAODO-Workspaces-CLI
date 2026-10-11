import { connect } from "../../client.mjs";
import { rethrowUnpublished } from "../../contract.mjs";
import { CliError, usageError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";
import { namedEnds } from "./endpoints.mjs";

/**
 * Every connection in the deployment, of both kinds — or, given an id, only the ones touching that one
 * thing. One request (GET /api/connections): the app reads both graphs together, names every end,
 * decides what the id is and how the answer is grouped, and refuses an id nothing answers to. Nothing
 * here joins, filters or orders.
 *
 * What is left is how a row prints. The app sends each end as `{ id, name }` under the role it plays;
 * here that becomes the name and, beside it, the id the next command takes — see endpoints.mjs. Every
 * row carries its own `id` first, because that is the handle `connection rm` takes and this listing is
 * the only place it is published.
 *
 * The reply's own keys are relayed rather than named here, so a group the app gains is printed at
 * once: a list is a group of rows, and the one object beside the lists is the thing that was asked
 * about, which goes to the envelope as its id and stays in the payload as its name.
 */
function printable(listing) {
  if (listing === null || typeof listing !== "object" || Array.isArray(listing)) return null;
  const subject = {};
  const payload = {};
  let groups = 0;
  for (const [key, value] of Object.entries(listing)) {
    if (Array.isArray(value)) {
      groups += 1;
      payload[key] = value.map(({ id, ...ends }) => ({ id, ...namedEnds(ends) }));
    } else {
      subject[`${key}Id`] = value?.id;
      payload[key] = value?.name;
    }
  }
  return groups === 0 ? null : { subject, payload };
}

async function run([reference]) {
  // Refused here because an empty `for` is a different question to the app than an absent one.
  if (reference === "") throw usageError("Workspace or drive id is required.");
  const query = reference === undefined ? "" : `?for=${encodeURIComponent(reference)}`;
  const listing = await connect()
    .json(`/api/connections${query}`)
    .catch((error) => rethrowUnpublished(error, "list its connections (GET /api/connections)"));
  const shown = printable(listing);
  if (!shown) throw new CliError("INVALID_RESPONSE", "PAODO returned an invalid connection listing.");
  receipt(shown.subject, shown.payload);
}

export default {
  min: 0,
  max: 1,
  run,
};
