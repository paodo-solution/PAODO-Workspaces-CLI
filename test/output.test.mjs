import { test } from "node:test";
import assert from "node:assert/strict";
import { format, prose } from "../src/output.mjs";

test("a one-line list or empty value stays in its run of fields, with no blank line around it", () => {
  const text = format({ internetAccess: true, allowedDomains: ["api.vercel.com"], skills: [], name: "Alpha" });
  assert.equal(text, "internetAccess : true\nallowedDomains : api.vercel.com\nskills : (none)\nname : Alpha");
});

test("a nested object is set apart by its header and a blank line", () => {
  assert.equal(format({ name: "Alpha", connections: { drives: 0 } }), "name : Alpha\n\nconnections :\n\ndrives : 0");
});

test("help text too wide for one line becomes `key :` with the text wrapped and indented beneath", () => {
  const long = "Values are not checked here — they are sent as given, and the app validates them.";
  assert.equal(
    format(prose({ description: "Short.", validation: long })),
    "description : Short.\n\nvalidation :\n  Values are not checked here — they are sent as given, and the app validates\n  them.",
  );
});

test("a group of terms prints as entries whatever their length, its long text wrapped", () => {
  const wide = "A key is usable only when its channel's access and hasKey are both true, as the app says.";
  assert.equal(
    format(prose({ fields: { a: "Short.", usable: wide } })),
    "fields :\n\n  a\n    Short.\n\n  usable\n    A key is usable only when its channel's access and hasKey are both true, as\n    the app says.",
  );
});
