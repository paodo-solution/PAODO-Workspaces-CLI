import { connect } from "../../client.mjs";
import { usageError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";

/**
 * Exactly one argument, the name.
 *
 * It used to take any number of them and join them with spaces, so an unquoted multi-word name still
 * worked. That courtesy cost more than it gave: `create "UX probe 3" llmProvider=openai` — the
 * spelling anyone carries over from `set`, which is the only other workspace command taking arguments
 * after the first — became a workspace literally named "UX probe 3 llmProvider=openai", created, and
 * reported as a success. Nothing downstream can see that: the name is valid, the id is real, and the
 * fields the caller asked for are simply absent. Every other command in this CLI refuses a surplus
 * argument, and this is the one where refusing matters most, because it is the one that writes.
 *
 * So the arity is fixed and the refusal names both spellings a caller who typed the old one meant,
 * rather than printing the usage line and leaving them to guess which half was wrong.
 */
function requireName([name, ...surplus]) {
  if (surplus.length > 0) {
    // What is named is what was refused, not a suggested spelling. The obvious message here — "quote
    // it", with the whole argument list joined back up as the example — is advice to type the wrong
    // thing on purpose whenever the surplus was `field=value`, which is the case this exists for.
    throw usageError(
      `Workspace create takes one name; ${surplus.map((word) => `"${word}"`).join(", ")} ${surplus.length === 1 ? "is" : "are"} surplus. ` +
        'A name containing spaces must be one quoted argument: paodo workspace create "My workspace". ' +
        "Fields are not set here — create it, then: paodo workspace set <workspace-id> field=value ...",
    );
  }
  const trimmed = name.trim();
  if (!trimmed) throw usageError("Workspace name is required.");
  return trimmed;
}

async function run(args) {
  const name = requireName(args);
  const { id, ...workspace } = await connect().json("/api/workspaces", { method: "POST", body: { name } });
  // The workspace it made, shaped exactly as `workspace get` returns one: the resource under
  // `workspace`, its id as the envelope's `workspaceId`. This is the only command that tells you an id
  // you did not already have, which is the reason that field is on the envelope at all.
  receipt({ workspaceId: id }, { workspace });
}

export default {
  min: 1,
  // Deliberately not Infinity: see requireName. The surplus is caught there rather than by this bound,
  // so the refusal can say what to type instead of repeating the usage line.
  max: Infinity,
  run,
};
