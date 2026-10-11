// Every word of help the CLI prints, keyed by command path without "paodo" ("" is the root); main.mjs reads it.
// A leaf needs `usage`; entries import a command's OPTIONS, and fileHelp writes both file groups once.
// A value may be a function, awaited when its entry prints: what the app owns is read from the app.
import { CliError } from "./errors.mjs";
import { describeFields, description, fromApp, channels, limit } from "./contract.mjs";
import { OPTIONS as FILE_CAT_OPTIONS } from "./commands/file/cat.mjs";

/** The app's own sentences about a resource — all of them, or the one under `key`. */
const app = (resource, key) =>
  fromApp(async () => {
    const sentences = await description(resource);
    if (key === undefined) return sentences;
    if (!Object.hasOwn(sentences, key)) throw new CliError("INVALID_RESPONSE", `PAODO's contract does not describe ${resource}.${key}.`);
    return sentences[key];
  });

/** The CLI's own lines first, then the app's sentences about `resource`, in one block. */
const appAfter = (first, resource) => fromApp(async () => ({ ...first, ...(await description(resource)) }));

/**
 * The six entries for one noun's file group, keyed the way main.mjs walks them.
 *
 * Two path spaces meet in this group, so every argument in it names the side it belongs to rather than
 * being called `path` or `dest` twice over. `get` and `put` are why: both used to spell their second
 * path `dest`, meaning this machine in one and the far side in the other, and a caller that swaps them
 * gets no error — a swapped transfer is a successful transfer in the wrong direction, which is the one
 * mistake no validation downstream can catch.
 *
 * What "local" means is defined once, in the root's vocabulary, and is not repeated here.
 */
function fileHelp(noun, notes = {}) {
  const id = `<${noun}-id>`;
  return {
    [`${noun} file`]: { usage: `paodo ${noun} file <ls|cat|get|put|rm> ...` },

    [`${noun} file ls`]: {
      usage: `paodo ${noun} file ls ${id} [${noun}-path]`,
      description: `List a ${noun}'s files.`,
      // One level per call, which the usage line cannot show and a caller that assumed otherwise would
      // read as an empty tree with three entries in it.
      help: {
        depth: "One level. A trailing slash marks a directory; name it to list what is inside.",
        [`${noun}-path`]: `Defaults to the ${noun} root.`,
        entries: {
          path: "A trailing slash marks a directory; name it to list what is inside.",
          lines:
            "What cat's --offset and --limit count in. Absent when there is nothing to window: an image, " +
            "an archive, a very large file.",
          contains:
            "Every file under a directory, however deep, counting only what a listing would show. " +
            "Absent when there are none.",
        },
        note: fromApp(async () => {
          const most = await limit("listingEntries");
          return (
            `Present only when a directory held more than ${most} entries, which is the most one ` +
            `call returns. The ones you get are an arbitrary ${most} of what is there — the cut ` +
            "happens before the sort — so name a directory inside to see the rest, rather than reading " +
            "past the end of the list you were given."
          );
        }),
        ...notes.ls,
      },
    },

    [`${noun} file cat`]: {
      usage: `paodo ${noun} file cat ${id} <${noun}-path> [--offset N] [--limit N]`,
      description: `Read a text file from a ${noun}.`,
      help: {
        options: FILE_CAT_OPTIONS,
        text:
          "Text only, window or no window: an image or a binary file is refused rather than printed, " +
          `since its bytes are not something a terminal can show. Use "paodo ${noun} file get" to pull ` +
          "one to this machine. ls says which is which — a file with no `lines` has nothing to print.",
        output:
          "The file as-is, except control characters other than tab and line breaks, shown as \\u001b and the " +
          "like. A failure goes to stderr with exit code 1, so text in the file that looks like one is not.",
        ...notes.cat,
      },
    },

    [`${noun} file get`]: {
      usage: `paodo ${noun} file get ${id} <${noun}-source> [local-dest]`,
      description: `Pull a file or directory from a ${noun} to this machine.`,
      // Spells out which way it crosses the boundary, and what the destination it can be called without
      // falls back to. Keyed by the placeholder each line explains.
      help: {
        direction: `${noun} -> this machine`,
        "local-dest":
          'Defaults to the source\'s own name in the current directory; "." merges into it, and any path ' +
          "that already exists there is overwritten rather than refused.",
        ...notes.get,
      },
    },

    [`${noun} file put`]: {
      usage: `paodo ${noun} file put ${id} <local-source> [${noun}-dest]`,
      description: `Push a file or directory from this machine to a ${noun}.`,
      help: {
        direction: `this machine -> ${noun}`,
        [`${noun}-dest`]:
          `Defaults to the source's own name at the ${noun} root; "." merges its contents directly into ` +
          "the root instead, and any path that already exists there is overwritten rather than refused.",
        ...notes.put,
      },
    },

    [`${noun} file rm`]: {
      usage: `paodo ${noun} file rm ${id} <${noun}-path>`,
      description: `Delete a file or directory from a ${noun}.`,
      help: {
        [`${noun}-path`]:
          "A trailing slash marks a directory — removes it and everything inside, in one receipt. " +
          `The ${noun} root ("/") is refused: name the entries to delete.`,
        removed:
          "Every path that went, the directory itself first. Long lists stop early; removedCount is " +
          "always the whole of it.",
        ...notes.rm,
      },
    },
  };
}

// Opens all three schedule entries, so whichever one a caller reads states the model first.
const SCHEDULE_MODEL =
  "One scheduled job per workspace. It always exists, either enabled or disabled, and every " +
  "receipt says which under `state`.";

export const HELP = {
  "": {
    usage: "paodo <app|workspace|drive|connection> ...",
    help: {
      purpose: "Creates and configures PAODO app workspaces for agentic ai.",
      vocabulary: {
        workspace:
          "A container PAODO created and configured, running its own agent — what the workspace commands " +
          "manage, and what a <workspace-id> argument names.",
        file:
          "A path inside a workspace's or a drive's own directory, as the app tracks it — relative to " +
          'that root, e.g. "src/main.ts", never "/workspace/src/main.ts". What the file commands read, ' +
          "write and list. Both nouns carry the same five: workspace file ls, drive file ls, and so on.",
        drive:
          "Shared storage on the host, connected to any number of workspaces, so a write to one is " +
          "visible to every workspace connected to it. Unlike a workspace it is not versioned: nothing " +
          "in a drive is recoverable through history, which is what makes drive rm final.",
        connection:
          "A drive link, or a one-way agent call from a caller workspace to a callee — the connection commands list, make and remove both.",
        conversation:
          "A workspace's message thread with its agent. Read here only: interacting with a workspace agent goes " +
          "through the workspace API or MCP.",
        session: "One agent execution inside a conversation: a message in, then the agent's work until it answers.",
        call: "One tool the agent ran during a session: what it was given and what it returned.",
        local: "An ordinary path on this machine, resolved from the current directory — the other side of a file transfer.",
        source: "Which path space — the workspace's, the drive's, or local — a transfer read from.",
        dest: "The path a transfer writes to — paired the same way, e.g. drive-dest, local-dest.",
        created: "Paths a transfer wrote where nothing was.",
        overwritten: "Paths a transfer replaced.",
        ignored: "Paths a transfer refused to carry.",
        removed: "Paths a delete destroyed.",
        note:
          "A caveat about the receipt holding it: what the command could not show in full, and what to " +
          "do about it. Present only when there is one, so a receipt without it is complete.",
        destination: "Which path space — the workspace's, the drive's, or local — a transfer wrote into.",
      },
      environment:
        "PAODO_ENDPOINT and PAODO_TOKEN, read from the .env file beside the CLI (resolved from the CLI's " +
        "own install location, not the current directory), or from exported variables, which take precedence.",
    },
  },

  app: { usage: "paodo app <status|models>" },
  "app status": { usage: "paodo app status", description: "Check the app's health." },
  "app models": { usage: "paodo app models", description: "List the LLM models available, with details." },

  workspace: { usage: "paodo workspace <ls|get|create|set|rm|key|schedule|conversation|file> ..." },
  "workspace ls": { usage: "paodo workspace ls", description: "List all workspaces." },
  "workspace get": {
    usage: "paodo workspace get <workspace-id>",
    description: "Get details about one workspace.",
    help: {
      connections:
        "How many drives it can address, workspaces that may call it, and workspaces it may call. " +
        "Counts only — `paodo connection ls <workspace-id>` names them and gives the id each is " +
        "removed by. Always present, so a zero is an answer rather than a missing field.",
    },
  },
  "workspace create": {
    usage: "paodo workspace create <name>",
    description: "Create a new workspace.",
    help: { name: "One argument. Quote it if it contains spaces." },
  },
  "workspace set": {
    usage: "paodo workspace set <workspace-id> field=value ...",
    description: "Configure a workspace's fields.",
    help: {
      fields: () => describeFields("workspace"),
      validation:
        "Values are not checked here — they are sent as given, and the app validates them; a rejected value comes back as the app's own error.",
    },
  },
  "workspace rm": { usage: "paodo workspace rm <workspace-id>", description: "Delete a workspace." },

  "workspace key": {
    usage: "paodo workspace key <generate|rotate|revoke> <workspace-id> <channel>",
    help: {
      channel: fromApp(async () => Object.keys(await channels()).join(", ")),
      fields: app("key"),
      order:
        "Generate the key first, then open the channel with workspace set workspaceApiAccess=true (or " +
        "workspaceMcpAccess=true), so it is never live while the key is still in transit.",
    },
  },
  "workspace key generate": {
    usage: "paodo workspace key generate <workspace-id> <channel>",
    description: "Mint a new API or MCP key for a workspace.",
  },
  "workspace key rotate": {
    usage: "paodo workspace key rotate <workspace-id> <channel>",
    description: "Replace a workspace's API or MCP key with a new one.",
  },
  "workspace key revoke": {
    usage: "paodo workspace key revoke <workspace-id> <channel>",
    description: "Revoke a workspace's API or MCP key.",
  },

  "workspace schedule": {
    usage: "paodo workspace schedule <get|set> <workspace-id> ...",
    help: { model: SCHEDULE_MODEL },
  },
  "workspace schedule get": {
    usage: "paodo workspace schedule get <workspace-id>",
    description: "Get a workspace's scheduled job and whether it is enabled or disabled.",
    help: {
      model: SCHEDULE_MODEL,
      ends:
        "When the job stops on its own: endAt, or never (runs until disabled) when it has none. Also on every set receipt.",
      "(none)": "A setting not set yet. A workspace that never had a job shows every setting so, disabled.",
      lastRun: app("schedule", "lastRun"),
      times: app("schedule", "times"),
    },
  },
  "workspace schedule set": {
    usage: "paodo workspace schedule set <workspace-id> field=value ...",
    description: "Configure, enable or disable a workspace's scheduled job.",
    help: {
      model: SCHEDULE_MODEL,
      fields: () => describeFields("schedule"),
      "first set":
        "Name intervalValue, intervalUnit, startAt and timezone, and prompt to enable — nothing is filled " +
        "in for you, and the app names every one missing in one error.",
      "enable, disable": "enabled=true enables the job and enabled=false disables it; its configuration is kept either way.",
      merge: "Only named fields are sent. The server merges them atomically; concurrent edits to different fields are preserved.",
      ends: "Printed on every receipt beside state: the endAt that stops the job, or never (runs until disabled).",
      timing: app("schedule", "timing"),
      applied: "Each field named, as the app stored it, then nextRunAt: when an enabled job fires next.",
      validation:
        "Values are not checked here — they are sent as given, and the app validates them; a rejected value comes back as the app's own error.",
    },
  },

  "workspace conversation": {
    usage: "paodo workspace conversation <ls|session> <workspace-id> ...",
  },
  "workspace conversation ls": {
    usage: "paodo workspace conversation ls <workspace-id>",
    description: "List a workspace's conversations, newest first.",
    help: {
      fields: app("conversation"),
      next: "id is what conversation session ls takes.",
    },
  },
  "workspace conversation session": {
    usage: "paodo workspace conversation session <ls|show|call> <workspace-id> <conversation-id> ...",
  },
  "workspace conversation session ls": {
    usage: "paodo workspace conversation session ls <workspace-id> <conversation-id>",
    description: "List a conversation's sessions, newest first, with the start of each one's message and answer.",
    help: {
      fields: app("sessionSummary"),
      next: "sessionId is what session show and session call ls take; session show prints the message and answer in full.",
    },
  },
  "workspace conversation session show": {
    usage: "paodo workspace conversation session show <workspace-id> <conversation-id> <session-id>",
    description: "Show one session: the user's message and the agent's final answer in full, and what it cost.",
    help: {
      fields: appAfter({ "(ls fields)": "sessionId, startedAt and status, as session ls gives them." }, "session"),
      next: "session call ls lists the tool calls callCount counts.",
      "not shown":
        "Tool calls, which session call ls lists. Reasoning and the system prompt are in the dashboard's " +
        "session drawer.",
    },
  },
  "workspace conversation session call": {
    usage: "paodo workspace conversation session call <ls|show> <workspace-id> <conversation-id> <session-id> ...",
  },
  "workspace conversation session call ls": {
    usage: "paodo workspace conversation session call ls <workspace-id> <conversation-id> <session-id>",
    description: "List a session's tool calls, oldest first, with the size of each one's input and output.",
    help: {
      fields: app("callSummary"),
      next: "callId is what session call show takes.",
      "not listed":
        "The input and output themselves. The two counts say what session call show would print, so a " +
        "call is opened only when it is worth reading.",
    },
  },
  "workspace conversation session call show": {
    usage:
      "paodo workspace conversation session call show <workspace-id> <conversation-id> <session-id> <call-id>",
    description: "Show one tool call: its input and output in full.",
    help: {
      fields: appAfter({ "(ls fields)": "callId, timestamp, tool and status, as session call ls gives them." }, "call"),
    },
  },

  // The workspace's five, generated by fileHelp above. A push here is committed to version history,
  // which is the one thing the drive's copy cannot say.
  ...fileHelp("workspace", {
    put: {
      history:
        "A push is one revision in the workspace's history, so it can be undone from there. The call " +
        "fails if that revision could not be written, even though the files landed.",
    },
  }),

  drive: { usage: "paodo drive <ls|get|create|set|rm|file> ..." },
  "drive ls": { usage: "paodo drive ls", description: "List all drives." },
  "drive get": {
    usage: "paodo drive get <drive-id>",
    description: "Get details about one drive.",
    help: {
      connections:
        "How many workspaces reach this drive. A count only — `paodo connection ls <drive-id>` names " +
        "them and gives the id each link is removed by. Always present, so a zero is an answer.",
    },
  },
  "drive create": {
    usage: "paodo drive create <name> [description]",
    description: "Create a new drive, with its description if you have one.",
    help: {
      name: "One argument. Quote it if it contains spaces.",
      // Bracketed to match the usage line, and because a bare `description` is the one-liner's own key.
      "[description]":
        "Optional, and one argument too — not field=value, which is drive set's spelling for changing " +
        "one later. Shown to every agent connected to the drive, so say what belongs in it.",
      unique: app("drive", "unique"),
    },
  },
  "drive set": {
    usage: "paodo drive set <drive-id> field=value ...",
    description: "Rename or re-describe a drive.",
    help: {
      fields: () => describeFields("drive"),
      validation:
        "Values are not checked here — they are sent as given, and the app validates them; a rejected value comes back as the app's own error.",
    },
  },
  "drive rm": {
    usage: "paodo drive rm <drive-id>",
    description: "Delete a drive, its connections, and its files.",
    help: {
      irreversible:
        "A drive is not versioned, so this is not recoverable from history the way a workspace file is. " +
        "Every workspace connected to the drive loses it.",
    },
  },

  // The same five, over a drive. Both notes repeat that a drive is shared and unversioned, since that is
  // what sets a write here apart, and a caller reads one command's help, not both.
  ...fileHelp("drive", {
    put: {
      shared:
        "Every workspace connected to the drive sees the write immediately, and a drive keeps no " +
        "history — an overwritten file is gone, not a revision back.",
    },
    rm: {
      irreversible:
        "Nothing in a drive is recoverable through history, and every workspace connected to it loses " +
        "what this removes.",
    },
  }),

  connection: { usage: "paodo connection <ls|create|rm>" },
  "connection ls": {
    usage: "paodo connection ls [workspace-id|drive-id]",
    description: "List every connection in the app — drive links and agent calls.",
    help: {
      "workspace-id|drive-id":
        "Optional, and it names no noun because it does not need to: the app knows which of the two " +
        "the id is, and that decides how the answer is shaped. Given a workspace, its drives, callers and callees, each " +
        "naming only the far end. Given a drive, the workspaces on it. Given neither, everything.",
      driveLinks: app("connection", "driveLinks"),
      agentCalls: app("connection", "agentCalls"),
      id:
        "The link's own handle, and the only place it is published. It belongs to the link rather than " +
        "to either end, so two workspaces sharing a drive have one id each.",
      "callerId, calleeId, driveId, workspaceId":
        "The id of the thing at that end of the link, next to its name — this is what the other " +
        "commands take, and it is published even where the name reads (not found).",
      "(not found)":
        "An id nothing answers to: a link left naming something since deleted, or one the app never " +
        "checked against anything. The link is real — what it names is not.",
      "vs the counts":
        "`workspace get` and `drive get` count connections under `connections`, in these same words. " +
        "They count what can still be reached, so a link naming something deleted is listed here and " +
        "counted nowhere — a group longer than its count is how you find one.",
    },
  },
  "connection create": {
    usage: "paodo connection create <drive-id|workspace-caller-id> <workspace-id|workspace-callee-id>",
    description: "Link a drive to a workspace, or let one workspace call another.",
    help: {
      "the two slots":
        "Each names both roles it can play, in order. Which kind of connection you are making is not " +
        "something to declare — the app decides it from what the two ids are, and refuses the pairs it " +
        "does not allow.",
      pairs: app("connection", "pairs"),
      "read it back": "What was made is printed as caller/callee or drive/workspace — read it rather than assume it.",
      "agent calls": app("connection", "agentCalls"),
      "drive links": app("connection", "driveLinks"),
      "running it twice": app("connection", "idempotent"),
      connectionId: "The new connection's handle, and what `connection rm` takes.",
    },
  },
  "connection rm": {
    usage: "paodo connection rm <connection-id>",
    description: "Remove one connection of either kind.",
    help: {
      "connection-id": app("connection", "connectionId"),
      "where to find one": "`connection ls` is where a connection id is published.",
      deleted:
        "false is an answer, not a failure: nothing is connected under that id now, which is what was " +
        "asked for. It is what a second run gets, and what an id whose workspace or drive was deleted " +
        "since `ls` printed it gets.",
      "what it costs":
        "Nothing is destroyed and nothing is confirmed first. Removing a drive link takes away one " +
        "workspace's reach into the drive, not the drive or its files; removing an agent call revokes " +
        "a delegation. Either is re-established by `connection create`.",
    },
  },
};
