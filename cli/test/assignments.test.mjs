import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAssignments, parseAssignments } from "../src/assignments.mjs";

const FIELDS = { intervalValue: { type: "int" }, enabled: { type: "boolean" }, allowedDomains: { type: "string[]" } };
const body = (...assignments) => encodeAssignments(parseAssignments(assignments), FIELDS);
const sent = (value) => body(`intervalValue=${value}`).intervalValue;

test("an int field sends plain decimal digits as a number", () => {
  assert.equal(sent("16"), 16);
  assert.equal(sent("-1"), -1);
});

test("an int field sends any other spelling as text, for the app to refuse", () => {
  for (const value of ["0x10", "1e2", "0b11", "1.5", " 16", "Infinity", ""]) assert.equal(sent(value), value);
});

test("a boolean field sends true and false as booleans, and anything else as text", () => {
  assert.equal(body("enabled=false").enabled, false);
  assert.equal(body("enabled=yes").enabled, "yes");
});

test("a string[] field sends comma-separated values as a list, and an empty value as an empty one", () => {
  assert.deepEqual(body("allowedDomains=api.vercel.com, github.com").allowedDomains, ["api.vercel.com", "github.com"]);
  assert.deepEqual(body("allowedDomains=").allowedDomains, []);
});

test("a field the contract does not name travels as text, for the app to refuse", () => {
  assert.equal(body("toString=1").toString, "1");
});
