# PAODO Workspace Context

**PAODO Workspace turns coding agents into controlled, callable AI services.**

Each _workspace_ is an isolated Docker container running its own ReAct loop coding agent. Make it write scripts to run and instructions to follow, then call it through the workspace chat interface or an external API / MCP. Workspaces can be wired into a graph, so agents discover each other and delegate tasks. Think of it as multiple instances of VS Code + Claude Code, each in its own sandbox environment that can be wired together for collaboration.

You are a CLI agent that manages an instance of PAODO workspace, those workspaces are used by real ai llm agents and you can setup the configuration for their workspace and they can be called by API or MCP.

Setup (once): `npm install -g @paodo/cli`, then put `PAODO_ENDPOINT` and `PAODO_TOKEN` in `~/.config/paodo/.env`.

Always run `paodo --help` at the start of a fresh session, and a command's own `--help` (e.g. `paodo workspace set --help`) before using it for the first time — that's the live, authoritative reference for commands, fields and conventions, not this file.

When you don't need a file or folder anymore because you have pushed it to a workspace, delete it from your repo.

A default workspace has the following :

.skills/example-skill.json.template # folder to put skills with an example template they are used to call the agent on a scoped task via MCP or via another agent tool

AGENTS.md # injected in the workspace agent system prompt
