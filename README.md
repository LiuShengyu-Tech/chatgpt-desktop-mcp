<p align="center"><img src="assets/cover.png" alt="Claude Code driving the ChatGPT desktop app" width="640"></p>

# chatgpt-desktop-mcp

**English** | [中文](README.zh-CN.md)

Let **Claude Code** (CLI or the Claude desktop app) drive the **ChatGPT desktop app** on Windows: create chats, send messages, wait for and read replies, and hand tasks to ChatGPT's built-in Codex agent inside your projects.

It connects to the ChatGPT desktop app through the Chrome DevTools Protocol on `127.0.0.1`. The window tools operate the visible interface; the `codex_*` tools send requests through the app's own internal, undocumented Codex channel (see [Limitations](#limitations)). It stores no tokens. Chats and agent activity show up in the app, so you can watch and take over at any time, although background `codex_*` calls do not necessarily open the thread they work on.

## What it is for

- **Second opinions**: Claude asks ChatGPT to review a plan, a piece of code or a piece of writing, then weighs the answer.
- **Delegation**: Claude hands a task to the Codex agent in one of your ChatGPT projects and reads back what it did.
- **One workspace**: chats Claude creates show up in your ChatGPT sidebar like any other, and you can continue them by hand.

## What's inside

| Part | File | Role |
|---|---|---|
| MCP server | `server.mjs` | The tools below. Zero dependencies, Node.js 22+. |
| Skill | `skills/chatgpt-desktop/SKILL.md` | Teaches Claude when and how to use the tools safely. |
| Plugin manifest | `.claude-plugin/plugin.json` | Lets Claude Code load the server and skill as one plugin. |
| Launcher | `start-chatgpt.ps1` | Starts ChatGPT with the local debugging port. |

## Tools

| Tool | What it does | Main arguments |
|---|---|---|
| `status` | Connection check: open chat title, mode, whether a reply is running. | none |
| `list_chats` | Chats in the sidebar with `id`, `title`, `kind` (`chatgpt` or `local`). | `limit` |
| `list_projects` | Folder-backed projects the app knows, with root paths. | none |
| `open_chat` | Open a chat. | `id` or `title` |
| `new_chat` | Start a chat: plain, in a sidebar project, or for a folder. | `project` or `cwd` |
| `send_message` | Send text to the open chat, wait for the reply, return it with its steps. | `text`, `wait`, `timeout_sec` |
| `read_chat` | Read the open chat. With steps: each turn's "Worked for …" time, interim notes and actions. | `last_n`, `include_steps` |
| `stop` | Stop the reply or agent task running in the open chat (the Stop button). | none |

Tip: `send_message` with `wait: false` starts a long task without blocking; check on it with `status` / `read_chat` and end it any time with `stop`.

### Codex agent tools (no clicking, shown live in the window)

These send requests to the Codex service built into ChatGPT, through the same internal channel the window uses. Nothing is clicked or typed, so your own clicks in the window don't interfere, yet every new thread, message, plan and goal shows up in the ChatGPT window right away.

| Tool | What it does | Main arguments |
|---|---|---|
| `preflight` | Pre-run check: ChatGPT running? debugging port open? app version and whether it was tested? internal channel answering? Starts nothing. | none |
| `restart_chatgpt` | Restart ChatGPT with the debugging port. Closes the window and interrupts running work, so only after you agree. | `confirm: true` |
| `codex_new_thread` | New Codex thread for a folder; appears in the sidebar. Optional first message, optionally in plan mode. | `cwd`, `prompt`, `plan`, `sandbox` (default `read-only`), `wait`, `open` |
| `codex_send` | Send a message to a thread; `plan: true` for plan mode. | `thread_id`, `text`, `plan`, `wait`, `timeout_sec` |
| `codex_read` | Thread status, goal and latest turns with every step: notes, plan, commands with output, file changes, tool calls. | `thread_id`, `last_turns` |
| `codex_interrupt` | Stop the running turn (like the Stop button). | `thread_id` |
| `codex_wait` | Wait for several threads; returns when the first one (or all) finishes or needs attention, with its reply. Blocks the call, so prefer the background watcher below when your client can run background commands. | `thread_ids`, `mode`, `timeout_sec` |
| `codex_goal_set` / `codex_goal_get` / `codex_goal_clear` | Give a thread a goal; it keeps working turn after turn until it marks the goal complete ("Pursuing goal" in the window). | `thread_id`, `objective`, `status`, `token_budget` |

`thread_id` accepts the id from `codex_new_thread` or a `local:…` id from `list_chats`. A finished goal is removed by the app, so `codex_goal_get` then returns `null`.

If ChatGPT is closed, the first tool call starts it with the debugging port and waits for the window to load. If it is open **without** the port, the tools stop and Claude asks you whether it may restart ChatGPT (`restart_chatgpt`). Set `CHATGPT_AUTO_RESTART=1` to allow that restart without being asked.

## Requirements

- Windows 10/11 with the ChatGPT desktop app (package `OpenAI.Codex`), signed in.
- Node.js 22 or newer.
- Claude Code (CLI) or the Claude desktop app.

## Install

1. Get the code:
   ```powershell
   git clone https://github.com/<you>/chatgpt-desktop-mcp.git D:\chatgpt-desktop-mcp
   ```
2. Register it with Claude Code. Pick one:
   - **As an MCP server** (tools only):
     ```powershell
     claude mcp add --scope user chatgpt-desktop -- node D:\chatgpt-desktop-mcp\server.mjs
     ```
   - **As a plugin** (tools + skill): load the folder as a Claude Code plugin; `.claude-plugin/plugin.json` points at the server.
3. Start a new Claude Code session so the tools load.

## Usage

Just ask Claude in plain words, for example:

- "Ask ChatGPT for a second opinion on this function and summarize where it disagrees."
- "In my MyApp project in ChatGPT, start a new chat and have Codex list the open TODOs. Read-only."
- "Read the last reply in my ChatGPT chat about the release plan."

To check the setup by hand:

```powershell
node D:\chatgpt-desktop-mcp\server.mjs call status
```

### Several Codex threads at once

When Claude hands out several tasks, it does not have to wait on each one. It sends them with `wait: false` and starts one background watcher:

```powershell
node D:\chatgpt-desktop-mcp\server.mjs wait --timeout 3600 <thread id> <thread id> ...
```

The watcher exits as soon as one thread finishes or needs attention (for example an approval prompt), or, with `--all`, when every thread is done. It prints JSON with each event and the latest reply. Claude Code is notified when a background command exits, so Claude reads the result, decides the next step and watches the rest again. Exit code 0 = events, 2 = timed out, 1 = error.

### Starting ChatGPT

The tools need ChatGPT running with `--remote-debugging-port=9222`. Either let the first tool call start it, or run:

```powershell
powershell -ExecutionPolicy Bypass -File D:\chatgpt-desktop-mcp\start-chatgpt.ps1
```

If ChatGPT is already open without the port, close it first or add `-Restart`. The plugin only closes your ChatGPT window through `restart_chatgpt` after you agreed, or when you set `CHATGPT_AUTO_RESTART=1`.

Settings: `CHATGPT_CDP_PORT` (default `9222`), `CHATGPT_AUTO_RESTART` (`1` = restart without asking), `CODEX_HOME` / `CODEX_GLOBAL_STATE` (where `list_projects` reads the app's project list).

## Safety

- `local` chats, and chats started with `cwd`, are a Codex agent that can read, edit and run commands on your computer, possibly with full access. Tell it to stay read-only unless you want changes. The bundled skill makes Claude do this by default.
- While ChatGPT runs with the debugging port, any local program can control it. The port only listens on `127.0.0.1`. Restart ChatGPT normally when you no longer need it.
- Replies from ChatGPT are treated as data, not as instructions to Claude.

## Limitations

- The window tools read the user interface, so a ChatGPT update can break selectors in `server.mjs`.
- The `codex_*` tools use an internal, undocumented channel of the app. It is not a public, supported API and may change between app versions. `preflight` reports the app version and probes the channel with one request; a successful probe does not prove every tool works. On an untested version the tools still run if the probe succeeds, with a warning, so check their results.
- Very long chats: `read_chat` only reads turns rendered in the window (`codex_read` has no such limit).
- `read_chat` steps show only the kind of action ("Ran a command"); `codex_read` returns the exact commands and their output.
- Windows only for now. Tested with ChatGPT desktop 26.1117 / Chromium 158.

## Disclaimer

An unofficial community project, not affiliated with or endorsed by OpenAI or Anthropic. ChatGPT and Codex are trademarks of OpenAI; Claude is a trademark of Anthropic. Use it on your own account and follow the terms of both services.

## License

[MIT](LICENSE)
