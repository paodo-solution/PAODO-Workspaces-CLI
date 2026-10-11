import { connect } from "../../client.mjs";
import { usageError } from "../../errors.mjs";
import { receipt } from "../../output.mjs";

/** The `set` spelling, carried over to a positional slot where it would be taken literally. */
const ASSIGNMENT = /^(?:name|description)=/;

/**
 * Name first, description second, both plain arguments — and no third. A surplus word is refused
 * rather than joined into either one: `create "Shared assets" scratch notes` would otherwise become a
 * drive described "scratch notes", created and reported as a success, with nothing downstream able to
 * see that a word landed somewhere the caller did not put it.
 *
 * `field=value` in the description slot is refused for the same reason. It is what anyone carries over
 * from `drive set`, and taken at face value it describes the drive as "description=scratch".
 */
function requireArgs([name, description, ...surplus]) {
  if (surplus.length > 0) {
    throw usageError(
      `Drive create takes a name and an optional description; ${surplus.map((word) => `"${word}"`).join(", ")} ` +
        `${surplus.length === 1 ? "is" : "are"} surplus. Each is one argument, quoted if it contains spaces: ` +
        'paodo drive create "Shared assets" "Scratch space for the render pipeline".',
    );
  }
  if (description !== undefined && ASSIGNMENT.test(description)) {
    throw usageError(
      `The description is a plain argument here, not a field: ` +
        `paodo drive create "${name}" "${description.slice(description.indexOf("=") + 1)}". ` +
        "field=value is drive set's spelling, for changing one later.",
    );
  }
  const trimmed = name.trim();
  if (!trimmed) throw usageError("Drive name is required.");
  return { name: trimmed, ...(description === undefined ? {} : { description }) };
}

async function run(args) {
  const { id, ...drive } = await connect().json("/api/drives", { method: "POST", body: requireArgs(args) });
  // Shaped exactly as `drive get` returns one: the resource under `drive`, its id as the envelope's
  // `driveId`. This is the only command that tells you an id you did not already have.
  receipt({ driveId: id }, { drive });
}

export default {
  min: 1,
  // Deliberately not 2: the surplus is caught in requireArgs, so the refusal can say what to type
  // instead of repeating the usage line.
  max: Infinity,
  run,
};
