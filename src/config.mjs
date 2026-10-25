// Two configuration sources: exported PAODO_ENDPOINT/PAODO_TOKEN, then the user's .env file, which
// bin/paodo.mjs loads before anything runs. Node's loadEnvFile fills only what is unset, so an
// exported variable always wins over the file.
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.mjs";

/** `$XDG_CONFIG_HOME/paodo/.env`, defaulting to `~/.config/paodo/.env`. */
export const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"),
  "paodo",
  ".env",
);

/** Plain http sends the token in the clear, so it is accepted only where the request never leaves this machine. */
function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

export function loadConfig() {
  const configuredEndpoint = process.env.PAODO_ENDPOINT?.trim();
  const token = process.env.PAODO_TOKEN?.trim();
  if (!configuredEndpoint || !token) {
    throw new CliError(
      "CLI_CONFIG_ERROR",
      `Configure PAODO_ENDPOINT and PAODO_TOKEN in ${CONFIG_FILE}, or export them.`,
    );
  }
  let endpoint;
  try {
    endpoint = new URL(configuredEndpoint);
  } catch {
    throw new CliError("CLI_CONFIG_ERROR", "PAODO_ENDPOINT must be a valid HTTP or HTTPS URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new CliError("CLI_CONFIG_ERROR", "PAODO_ENDPOINT must use http or https.");
  }
  if (endpoint.protocol === "http:" && !isLoopback(endpoint.hostname)) {
    throw new CliError("CLI_CONFIG_ERROR", "PAODO_ENDPOINT must use https unless it points at this machine (localhost).");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new CliError("CLI_CONFIG_ERROR", "PAODO_ENDPOINT must not contain credentials, a query, or a fragment.");
  }
  return { endpoint: endpoint.toString().replace(/\/+$/, ""), token };
}
