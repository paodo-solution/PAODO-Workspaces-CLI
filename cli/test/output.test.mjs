import { test } from "node:test";
import assert from "node:assert/strict";
import { format } from "../src/output.mjs";

test("a one-line list or empty value stays in its run of fields, with no blank line around it", () => {
  const text = format({ internetAccess: true, allowedDomains: ["api.vercel.com"], skills: [], name: "Alpha" });
  assert.equal(text, "internetAccess : true\nallowedDomains : api.vercel.com\nskills : (none)\nname : Alpha");
});

test("a nested object is set apart by its header and a blank line", () => {
  assert.equal(format({ name: "Alpha", connections: { drives: 0 } }), "name : Alpha\n\nconnections :\n\ndrives : 0");
});
