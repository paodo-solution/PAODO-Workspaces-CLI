import { once } from "node:events";
import { Readable } from "node:stream";
import { connect } from "../../client.mjs";
import { CliError } from "../../errors.mjs";
import { filePath } from "./route.mjs";

/**
 * The window `cat` can read instead of the whole file, spelled once: the value is both the set of
 * options the parser accepts (see `options` below) and the description help.mjs shows for each, which
 * imports this rather than restating it, so an option cannot be accepted but undocumented. This is the
 * one command in the group that takes options at all.
 *
 * Lines, and 0-based like the workspace agent's own `file_read` tool, because the same agent uses both
 * and one of them meaning "line 50" by `offset: 50` while the other means line 51 is a mistake whose
 * only symptom is off-by-one content. Ranges are the app's rule; what
 * is written here is what to type.
 */
export const OPTIONS = {
  offset: { type: "int", text: "0-based line to start at. Omit for the first line." },
  limit: { type: "int", text: "How many lines to return. Omit for the rest of the file." },
};

/**
 * Refuses anything that is not text, before a byte of it reaches stdout.
 *
 * A window is already refused by the app — a line is a thing only text has — and `ls` already omits
 * `lines` for the same files, so an unwindowed `cat` was the one path that knew and did not ask: it
 * streamed a PNG straight into the caller's terminal. That is a wrong answer twice over, since the
 * bytes are unreadable to a person and are the sort of thing an agent has to carry for the rest of its
 * context, and the receipt every other command answers with is what it lost by getting them.
 *
 * The media type is the app's own classification relayed by the content route, which is why it is read
 * rather than guessed here: the CLI never decides what counts as text, and this refusal and the app's
 * are the same judgement reported at two points. Read off the headers, so it lands before the body.
 */
function requireText(response, name, noun) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (mediaType.startsWith("text/")) return;
  throw new CliError(
    "CLI_NOT_TEXT_FILE",
    `${name} is not a text file, so it has nothing to print. Use "paodo ${noun} file get" to pull it to this machine.`,
    { details: { mediaType: mediaType || null } },
  );
}

/** Control bytes but tab, newline and a CRLF's \r: they would steer the terminal rather than print. */
const CONTROL = /\r(?!\n)|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Read as latin1 so every other byte, UTF-8 included, round-trips exact while a control byte shows as `\u001b`. */
function visible(text) {
  const shown = text.replace(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return Buffer.from(shown, "latin1");
}

async function write(bytes) {
  if (!process.stdout.write(bytes)) await once(process.stdout, "drain");
}

/**
 * Reads a text file, or with `--offset`/`--limit` the lines of it a caller asks for.
 *
 * The window travels as query parameters and is applied by the app, not to the stream arriving here.
 * Reading twenty lines is asked for precisely when a file is too big to want all of, so slicing locally
 * would pull the whole thing across the network and past this process to print a screenful of it — and
 * it would make the CLI the second place that decides what a line is. Nothing is buffered either way:
 * the response body is piped to stdout as it arrives.
 */
export default function (space) {
  async function run([reference, spacePath], { offset, limit } = {}) {
    const id = space.requireId(reference);
    const query = { path: spacePath, raw: "1", offset, limit };
    const response = await connect().request(filePath(space, id, "content", query), {
      accept: "text/plain",
    });
    requireText(response, spacePath, space.noun);
    if (!response.body) return;
    let held = "";
    for await (const chunk of Readable.fromWeb(response.body)) {
      const text = held + Buffer.from(chunk).toString("latin1");
      // A \r ending the chunk may be a CRLF's first half, so it waits for the byte after it.
      held = text.endsWith("\r") ? "\r" : "";
      await write(visible(held ? text.slice(0, -1) : text));
    }
    if (held) await write(visible(held));
  }

  return { min: 2, max: 2, run, options: OPTIONS };
}
