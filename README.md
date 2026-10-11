# PAODO Workspaces CLI

Command-line client for a PAODO Workspace app.

PAODO Workspace turns coding agents into controlled, callable AI services. Each workspace is an
isolated container running its own coding agent, reachable through chat, an API or MCP. `paodo`
lets you manage a whole app from a terminal or a script.

## Requirements

- Node.js 22 or later
- The base URL of your PAODO app and a CLI token for it

## Install

```bash
cd cli
npm install
npm link          # puts `paodo` on your PATH
```

## Configure

Copy `cli/.env.example` to `cli/.env`, then fill in `PAODO_ENDPOINT` (no trailing slash) and
`PAODO_TOKEN`. The file is read from `cli/` wherever you run `paodo` from. Exported variables of
the same name take precedence over it.

## Usage

```bash
paodo <group> <command> [arguments]
paodo --help                # the full command tree
paodo <group> ... --help    # arguments and fields of one command
```

| Group | What it manages |
|---|---|
| `app` | The app itself: health and the LLM models it offers |
| `workspace` | Workspaces: create, configure, delete |
| `workspace key` | API and MCP keys of a workspace |
| `workspace schedule` | A workspace's scheduled job |
| `workspace conversation` | Conversations, their sessions and tool calls |
| `workspace file` | Files inside a workspace: list, read, pull, push, delete |
| `drive` | Shared drives and the files they hold |
| `connection` | Links between a drive and a workspace, or between two workspaces |

The built-in help is the authoritative reference; this table is only a map.

## Tests

```bash
cd cli && npm test               # unit tests, no network
node tests/run.mjs --offline     # regression groups that never reach the app
node tests/run.mjs               # full run against the configured app
```

The full run creates and deletes real workspaces and drives on the configured app.
