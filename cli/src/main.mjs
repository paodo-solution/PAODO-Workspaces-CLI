// Dispatch: turn an argument list into one command, or into help. What the commands are and what each
// one does is in src/commands/ — one file per command, assembled into the tree by commands/index.mjs.
// What each one is called and says under `--help` is in src/help.mjs, keyed by the same path this file
// walks — that separation, not this file, is where usage/description/help text lives; nothing below
// declares any of it.
import { ROOT } from "./commands/index.mjs";
import { HELP } from "./help.mjs";
import { parse } from "./args.mjs";
import { usageError } from "./errors.mjs";
import { print, prose } from "./output.mjs";

const wantsHelp = (word) => word === undefined || word === "help" || word === "-h" || word === "--help";

/** help.mjs's entry for the path walked so far — "" at the root, "app key generate" style below it. */
function textFor(path) {
  const entry = HELP[path];
  if (!entry) throw new Error(`No help.mjs entry for "paodo ${path}". Add one.`);
  return entry;
}

/**
 * A leaf's own usage and description together, or — for a group — every command beneath it, however
 * many levels deep. A group nested inside a group (`workspace key`) used to flatten to its own one-line
 * usage here, which meant the root's help never showed `generate`/`rotate`/`revoke` at all: one
 * `--help` call has to surface every leaf, not just the ones one level down. And a leaf used to show
 * only what it does, not how it is spelled, which meant the exact argument syntax was a second
 * `--help` call away on every single command — the opposite of one call being enough.
 */
function usageTree(node, path) {
  if (!node.commands) {
    const { usage, description } = textFor(path);
    return description ? `${usage} # ${description}` : usage;
  }
  // A leaf's own name would only repeat what its usage line already spells out, so leaves collect
  // into one unlabeled ("") run instead of one "name : ..." entry each; a child that is itself a
  // group keeps its own name, so it still gets a header of its own (see the "" convention in
  // output.mjs's objectBlocks).
  const leaves = [];
  const groups = {};
  for (const [name, child] of Object.entries(node.commands)) {
    const value = usageTree(child, path ? `${path} ${name}` : name);
    if (typeof value === "string") leaves.push(value);
    else groups[name] = value;
  }
  return { ...(leaves.length ? { "": leaves.join("\n") } : {}), ...groups };
}

/** Keys this function composes itself, so an entry's `help` may not also spell them. */
const RESERVED = ["description", "commands"];

/**
 * One shape for every node: what sits under it and what it does, in that order, so a caller sees every
 * runnable command before anything else. No `usage` here even for a leaf — its full spelling already
 * printed in the parent group's `commands` list one `--help` call up, and `usageError` (below) still
 * reads it straight from help.mjs for the case that actually needs it: wrong argument count.
 *
 * An entry's `help` keys land in this same object, so one named like a reserved key used to overwrite
 * it and drop that line with nothing said — a leaf lost the sentence saying what it does, on its own
 * `--help`, which is exactly where it is read. Refused here now, the way a missing entry is.
 */
/** A function is a value only the app can give (see contract.mjs), asked for when its entry prints. */
async function settle(value) {
  if (typeof value === "function") return settle(await value());
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const settled = {};
  for (const [key, item] of Object.entries(value)) settled[key] = await settle(item);
  return settled;
}

async function help(node, path) {
  const { description, help: extra } = textFor(path);
  const clashes = Object.keys(extra ?? {}).filter((key) => RESERVED.includes(key));
  if (clashes.length) {
    throw new Error(`help.mjs entry for "paodo ${path}" has help key(s) --help reserves: ${clashes.join(", ")}. Rename them.`);
  }
  const resolved = await settle(extra ?? {});
  return prose({
    ...(description ? { description } : {}),
    ...(node.commands ? { commands: usageTree(node, path) } : {}),
    ...resolved,
  });
}

export async function run(argv) {
  let command = "paodo";
  let path = "";
  let node = ROOT;
  let args = argv;

  // Walk down the tree one word at a time, each group narrowing the list the next word is checked
  // against. A loop rather than a case per level, so `workspace key generate` needs no new dispatch.
  while (node.commands) {
    const [word, ...rest] = args;
    if (wantsHelp(word)) {
      print(await help(node, path));
      return;
    }
    // The command always comes first. Anything else leading is an option nobody can attribute to a
    // command yet, so there is no option spec to check it against.
    if (word.startsWith("-")) throw usageError(`Unknown option "${word}". Run: ${command} --help`);
    const child = node.commands[word];
    if (!child) throw usageError(`Unknown command "${command} ${word}". Run: ${command} --help`);
    command = `${command} ${word}`;
    path = path ? `${path} ${word}` : word;
    node = child;
    args = rest;
  }

  // The leaf's own option declaration, so a flag is checked against the command it was written for.
  // A command that declares none is handed an empty spec and refuses every option, as before.
  const { help: asked, positional, options } = parse(args, node.options);
  if (asked) {
    print(await help(node, path));
    return;
  }
  if (positional.length < node.min || positional.length > node.max) {
    throw usageError(`Usage: ${textFor(path).usage}`);
  }
  return node.run(positional, options);
}
