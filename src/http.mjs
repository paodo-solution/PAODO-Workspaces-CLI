// One request against a PAODO platform route, authenticated with the instance CLI token.
//
// Two layers, deliberately: `request` owns the transport — auth header, the manual-redirect rule, the
// network-failure taxonomy, and turning a non-2xx into a CliError carrying the app's own code and
// requestId. `json` adds only the JSON encode/decode on top. Splitting them is what lets a body that
// is not JSON (an archive streaming down, file bytes going up) reuse the identical failure
// vocabulary instead of growing a second, subtly different one — the case where a request fails is
// exactly the case where you cannot afford two answers about why.
import { CliError } from "./errors.mjs";

// `CLI_HTTP_` rather than the app's own naming (`INVALID_REQUEST`, `NOT_FOUND`, ...): these fire only
// when there is no `body.code` to relay — something between this CLI and the app answered instead of
// it, so the code has to say a guess from the raw HTTP status, not the app's own word for what went
// wrong. Sharing the app's vocabulary here would make every fallback look like an authoritative answer
// the app never gave.
const CODE_BY_STATUS = {
  400: "CLI_HTTP_INVALID_REQUEST",
  401: "CLI_HTTP_UNAUTHORIZED",
  403: "CLI_HTTP_FORBIDDEN",
  404: "CLI_HTTP_NOT_FOUND",
  409: "CLI_HTTP_CONFLICT",
  429: "CLI_HTTP_RATE_LIMITED",
  500: "CLI_HTTP_INTERNAL_ERROR",
  503: "CLI_HTTP_SERVICE_UNAVAILABLE",
};

/**
 * The app contract this CLI's routes and receipts were written against. The app names the one it serves
 * on every response (`X-Paodo-Contract`); an app from before the header names none and is not judged.
 */
export const CONTRACT_VERSION = 2;

let skewWarned = false;

/** A sentence when the app serves another contract than this CLI was written for, else undefined. */
function contractSkew(response) {
  const served = response.headers.get("x-paodo-contract")?.trim();
  if (!served || served === String(CONTRACT_VERSION)) return undefined;
  return (
    `This CLI was written for PAODO contract v${CONTRACT_VERSION} and this app serves v${served}, ` +
    "so a command may be refused or its receipt misread. Update whichever is older."
  );
}

function errorChain(error) {
  const chain = [];
  const pending = [error];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current || (typeof current !== "object" && typeof current !== "function") || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if ("cause" in current) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return chain;
}

function networkFailure(error) {
  const chain = errorChain(error);
  const causeCode = chain.find((item) => typeof item.code === "string")?.code;
  const names = chain.map((item) => item.name);
  let code = "NETWORK_ERROR";
  let message = "Could not reach PAODO.";

  if (names.includes("TimeoutError") || causeCode === "ETIMEDOUT") {
    code = "NETWORK_TIMEOUT";
    message = "The PAODO request timed out.";
  } else if (causeCode === "ECONNREFUSED") {
    code = "NETWORK_CONNECTION_REFUSED";
    message = "PAODO refused the connection.";
  } else if (causeCode === "ENOTFOUND" || causeCode === "EAI_AGAIN") {
    code = "NETWORK_DNS_ERROR";
    message = "The PAODO hostname could not be resolved.";
  } else if (
    typeof causeCode === "string" &&
    (causeCode.startsWith("ERR_TLS") || causeCode.startsWith("CERT_") || causeCode.startsWith("DEPTH_"))
  ) {
    code = "NETWORK_TLS_ERROR";
    message = "PAODO's TLS connection could not be verified.";
  } else {
    const specific = [...chain]
      .reverse()
      .find((item) => typeof item.message === "string" && item.message !== "fetch failed");
    if (specific) message = `Could not reach PAODO: ${specific.message}`;
  }

  return new CliError(code, message, { ...(causeCode ? { details: { causeCode } } : {}) });
}

/**
 * A failed response, as the CLI's own error. The app's `{ ok, code, error, details, requestId }`
 * envelope is relayed verbatim where it is present, so the CLI never paraphrases a rejection the app
 * already worded.
 */
async function failure(response) {
  const text = await response.text();
  let body = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed;
  } catch {
    // Older deployments and upstream proxies may still answer with plain text.
  }
  const code =
    typeof body.code === "string" && body.code ? body.code : (CODE_BY_STATUS[response.status] ?? `HTTP_${response.status}`);
  const message =
    typeof body.error === "string" && body.error
      ? body.error
      : text || response.statusText || `PAODO returned HTTP ${response.status}.`;
  const requestId =
    typeof body.requestId === "string" && body.requestId
      ? body.requestId
      : response.headers.get("x-request-id")?.trim() || undefined;
  const details =
    body.details && typeof body.details === "object" && !Array.isArray(body.details) ? body.details : undefined;
  const publicBody =
    body.ok === false && typeof body.code === "string" && typeof body.error === "string" ? body : undefined;
  return new CliError(code, message, { details, requestId, publicBody, hint: contractSkew(response) });
}

/**
 * The transport. Resolves with the successful Response — body unread, so a caller can stream it —
 * and throws a CliError for a network failure, a redirect, or any non-2xx.
 *
 * `body` may be a JSON-serialisable value (encoded here, with the JSON content type) or a raw
 * Uint8Array/string/stream, in which case the caller supplies its own `contentType` and nothing is
 * re-encoded. `accept` defaults to JSON.
 */
export async function request(endpoint, token, resource, { method = "GET", body, contentType, accept } = {}) {
  const raw = contentType !== undefined;
  const hasBody = body !== undefined;
  let response;
  try {
    response = await fetch(`${endpoint}${resource}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept ?? "application/json",
        ...(hasBody ? { "Content-Type": raw ? contentType : "application/json" } : {}),
      },
      ...(hasBody ? { body: raw ? body : JSON.stringify(body) } : {}),
      // Required by Node when the body is a stream; harmless otherwise.
      ...(raw ? { duplex: "half" } : {}),
      // A CLI cannot complete an interactive sign-in redirect. Following one would turn the final
      // HTML login page into an apparently successful 200 response.
      redirect: "manual",
    });
  } catch (error) {
    throw networkFailure(error);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new CliError(
      "INVALID_RESPONSE",
      "PAODO redirected the request. Use the programmatic endpoint, not the interactive UI URL.",
    );
  }
  if (!response.ok) throw await failure(response);
  // A success under another contract is the dangerous case — nothing else would say so — and stderr
  // keeps the warning out of the receipt a caller parses.
  const skew = contractSkew(response);
  if (skew && !skewWarned) {
    skewWarned = true;
    console.error(`warning : ${skew}`);
  }
  return response;
}

export async function json(endpoint, token, resource, options = {}) {
  const response = await request(endpoint, token, resource, options);
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new CliError(
      "INVALID_RESPONSE",
      `PAODO returned a non-JSON success response${mediaType ? ` (${mediaType})` : ""}.`,
    );
  }
  try {
    return JSON.parse(await response.text());
  } catch {
    throw new CliError("INVALID_RESPONSE", "PAODO returned invalid JSON.");
  }
}
