#!/usr/bin/env node

import { loadEnvFile } from "node:process";
import { CONFIG_FILE } from "../src/config.mjs";
import { run } from "../src/main.mjs";
import { failureBody } from "../src/errors.mjs";
import { formatResult } from "../src/output.mjs";

// The user's own .env, outside the install directory so an upgrade never replaces it.
// Optional: exported variables work when the file is absent, and win over it when both are set.
try {
  loadEnvFile(CONFIG_FILE);
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
}

run(process.argv.slice(2)).catch((error) => {
  console.error(formatResult(failureBody(error)));
  process.exitCode = 1;
});
