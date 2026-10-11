#!/usr/bin/env node

import { loadEnvFile } from "node:process";
import { run } from "../src/main.mjs";
import { failureBody } from "../src/errors.mjs";
import { formatResult } from "../src/output.mjs";

// Load the CLI's own .env, resolved from this file so it works wherever the CLI is installed.
// Optional: exported variables work when the file is absent.
try {
  loadEnvFile(new URL("../.env", import.meta.url));
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

run(process.argv.slice(2)).catch((error) => {
  console.error(formatResult(failureBody(error)));
  process.exitCode = 1;
});
