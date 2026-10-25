// Command results as terminal text: `key : value` per one-line field; a nested value gets a `key :` header,
// a blank line, then its own fields flush left. Only help indents: prose too wide for a line, kubectl style.
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value) {
  return !isPlainObject(value) && !Array.isArray(value);
}

function scalar(value) {
  return value === null || value === undefined || value === "" ? "(none)" : String(value);
}

/** The widest line help prints, so a page reads in an 80-column terminal. */
const WIDTH = 80;

/** Greedy word wrap to `width`; a longer word keeps a line of its own rather than being cut. */
function wrap(text, width) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  return current ? [...lines, current] : lines;
}

/** Help text too wide for its `key : value` line, printed as `key :` with the text wrapped and indented beneath. */
class Paragraph {
  constructor(text) {
    this.text = text;
  }
}

/** One term as kubectl explain lays it out: its head, then its text wrapped and indented beneath. */
export function entry(head, text) {
  return [`  ${head}`, ...wrap(text, WIDTH - 4).map((line) => `    ${line}`)].join("\n");
}

const fits = (key, item) => `${key} : ${item}`.length <= WIDTH;

/** A group of named terms, printed as entries whatever their length, so one kind of group has one look. */
function terms(group) {
  const items = Object.entries(group);
  if (!items.every(([key, item]) => key && typeof item === "string")) return group;
  return { "": items.map(([key, item]) => entry(key, item)).join("\n\n") };
}

/** Help as printed: a top-level string too wide for one line becomes a Paragraph, a nested group its entries. */
export function prose(help) {
  return Object.fromEntries(
    Object.entries(help).map(([key, item]) => [
      key,
      typeof item === "string" && key && !fits(key, item) ? new Paragraph(item) : isPlainObject(item) ? terms(item) : item,
    ]),
  );
}

/** An object's own fields as blocks — a run of consecutive one-line fields is one block; a nested field is a header block plus its own value's blocks, in the object's own key order. */
function objectBlocks(obj) {
  const entries = Object.entries(obj);
  if (entries.length === 0) return [["(none)"]];
  const result = [];
  let run = [];
  for (const [key, value] of entries) {
    if (value instanceof Paragraph) {
      if (run.length) result.push(run);
      run = [];
      result.push([`${key} :`, ...wrap(value.text, WIDTH - 2).map((line) => `  ${line}`)]);
      continue;
    }
    if (isScalar(value)) {
      // An empty key means the caller already wrote the line(s) with nothing to label — help's
      // command lists do this so a command's own usage isn't preceded by its own name again.
      run.push(key ? `${key} : ${scalar(value)}` : scalar(value));
      continue;
    }
    const blocks = fieldBlocks(key, value);
    if (blocks.length === 1 && blocks[0].length === 1) {
      run.push(blocks[0][0]);
      continue;
    }
    if (run.length) result.push(run);
    run = [];
    result.push(...blocks);
  }
  if (run.length) result.push(run);
  return result;
}

/** One field's blocks: an empty or all-scalar array collapses to one line; anything else gets a `key :` header followed by its contents' own blocks. */
function fieldBlocks(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return [[`${key} : (none)`]];
    if (value.every(isScalar)) return [[`${key} : ${value.map(scalar).join(", ")}`]];
    return [[`${key} :`], ...value.flatMap(itemBlocks)];
  }
  const entries = Object.entries(value);
  return entries.length === 0 ? [[`${key} : (none)`]] : [[`${key} :`], ...objectBlocks(value)];
}

/** One array item's blocks: an object item's own fields, or a bare scalar line — items get no index, since nothing here numbers or nests them. */
function itemBlocks(item) {
  if (isPlainObject(item)) return objectBlocks(item);
  if (!Array.isArray(item)) return [[scalar(item)]];
  return item.length === 0 ? [["(none)"]] : item.every(isScalar) ? [[item.map(scalar).join(", ")]] : item.flatMap(itemBlocks);
}

/** A value — always a plain object, from `help()` or `receipt()` below — as the text that prints it. */
export function format(value) {
  return objectBlocks(value)
    .map((block) => block.join("\n"))
    .join("\n\n");
}

export function print(value) {
  console.log(format(value));
}

/** Text the CLI writes itself, like `(not found)`: printed bare, so it never reads as a quoted value from the app. */
export class Note {
  constructor(text) {
    this.text = text;
  }
}

/** A key bare as the app sent it, unless a control character or emptiness would let it pass for a line of ours. */
function label(key) {
  return key === "" || /[\x00-\x1f\x7f]/.test(key) ? JSON.stringify(key) : key;
}

/** Every string JSON-quoted, so a line break or terminal escape in a value or key prints as `\n`, never as a line of its own. */
function quoted(value) {
  if (value instanceof Note) return value.text;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return value.map(quoted);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [label(key), quoted(item)]));
  return value;
}

/** A command's result or failure, its text quoted — unlike help, which is ours and lays out its own lines. */
export function formatResult(value) {
  return format(quoted(value));
}

/**
 * A receipt: `ok` first, then what was acted on, then the payload.
 *
 * One envelope for every command, reads included: a resource goes under its own key (`workspace`,
 * `workspaces`, `entries`, ...) rather than being printed bare, since a bare list has nowhere to carry
 * `ok`. The one exception is `file cat`, which prints the file's own bytes and nothing else.
 *
 * Mutations are the case that needed this, because their reply exists only to say what happened.
 * There were five of them in five shapes, three with no `ok` at all, so telling a success from a
 * failure meant already knowing which command's answer you were holding. A failure is
 * `{ ok: false, code, error }` (errors.mjs); with this, `ok` is the one key present either way and a
 * caller branches on it without a table of shapes.
 *
 * `subject` — `{ workspaceId }`, `{ driveId }`, or null for a command that acts on the app itself — is
 * added here rather than by the app because it is a fact about the call: the app answers about the
 * resource, while a caller reading a receipt wants to know what its own invocation touched, which for
 * `create` is the only place that id ever appears. It is an object rather than a bare id because the
 * key is the half that says which kind of thing was acted on, and a CLI with two resources in it
 * cannot leave that to the reader's memory of which command they ran.
 *
 * The payload keeps whatever names the app gave it; harmonizing the envelope is the point, and
 * renaming a payload would only add a second vocabulary to learn.
 */
export function receipt(subject, payload = {}) {
  console.log(formatResult({ ok: true, ...(subject ?? {}), ...payload }));
}
