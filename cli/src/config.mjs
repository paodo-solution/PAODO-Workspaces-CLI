// The local prototype has one configuration source: the .env file beside the CLI, loaded by
// bin/paodo.mjs from its own location so the CLI works from any directory. Exported variables with
// the same names also work and take precedence through Node's environment handling.
import { CliError } from "./errors.mjs";

export function loadConfig() {
  const configuredEndpoint = process.env.PAODO_ENDPOINT?.trim();
  const token = process.env.PAODO_TOKEN?.trim();
  if (!configuredEndpoint || !token) {
    throw new CliError(
      "CLI_CONFIG_ERROR",
      "Configure PAODO_ENDPOINT and PAODO_TOKEN in the .env file beside the CLI, or export them.",
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
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new CliError("CLI_CONFIG_ERROR", "PAODO_ENDPOINT must not contain credentials, a query, or a fragment.");
  }
  return { endpoint: endpoint.toString().replace(/\/+$/, ""), token };
}
