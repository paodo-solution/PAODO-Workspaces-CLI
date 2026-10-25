// Positional and option parsing for one command's arguments.
//
// A command declares the options it takes, and anything else leading with a dash is a usage error
// before a request goes out. That refusal is the point: an agent reaching for a plausible `--dry-run`
// or `--force` is told the flag does not exist, rather than having it dropped as unrecognised and being
// handed an ok receipt for a rehearsal that was really the operation. A command that declares nothing
// therefore takes nothing, which is most of them. The same reason `--` still ends option parsing: a
// path that begins with a dash is a path.
//
// What is checked here is the shape of the argument list — is this flag one this command has, was it
// given a value, was it given twice. What a value may say is the app's (see the CLI's own note on this
// in commands/workspace/set.mjs): a value travels as the string it arrived as, so `--offset abc` is
// refused by the route that owns the rule, in the same words the UI would get, not by a second copy here.
import { usageError } from "./errors.mjs";

/**
 * @param argv the command's arguments, with the command name already removed
 * @param spec the options this command declares, as `{ name: { type, text } }` — what `--help` prints,
 *   so the set that parses and the set that is documented cannot drift apart
 * @returns `{ help, positional, options }`, options keyed by name with string values
 */
export function parse(argv, spec = {}) {
  const positional = [];
  const options = Object.create(null);
  let acceptOptions = true;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (acceptOptions && argument === "--") {
      acceptOptions = false;
      continue;
    }
    if (!acceptOptions || !argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    // `--name=value` and `--name value` both, because an agent writes both and neither spelling is
    // wrong. Only the long form is a declared option: a one-letter alias would be a second name for
    // the same thing to keep in step with the help text.
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    if (!argument.startsWith("--") || !Object.hasOwn(spec, name)) {
      throw usageError(`Unknown option "${argument}".`);
    }
    if (name in options) throw usageError(`Option "--${name}" was supplied more than once.`);

    // A value taken positionally is taken whatever it looks like, including another dash — the app
    // owns what the value may be, and it names the offending option in its refusal. Only a missing one
    // is decided here, because there is nothing to send and nothing to refuse it.
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value === "") throw usageError(`Option "--${name}" needs a value.`);
    options[name] = value;
  }

  return { help, positional, options };
}
