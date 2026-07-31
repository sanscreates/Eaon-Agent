# Eaon Agent — v1.4

**Token-efficient terminal AI coding agent.** Connect whatever providers you want. Two-model architecture: a strong **main** model does the agentic work, a cheap **compressor** model eats the context. Caveman mode on by default. macOS + Linux.

> why use many tokens when few do the trick

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/sanscreates/Eaon-Agent/main/install.sh | bash
```

Installs Node ≥18 if needed, then `eaon-agent` globally. First run drops you into onboarding.

```bash
eaon-agent setup   # connect providers, pick main + compressor models
eaon-agent         # start
```

Upgrade: re-run the same curl line. Uninstall: `npm rm -g eaon-agent`.

## The efficiency architecture

```
you ──► main model (strong, expensive)          ◄── agentic work
           ▲ context: system + [<compressed_context>] block + last 5 msgs raw
           │              ▲                         ▲
           │              └── compressed summary ────┘
           │        (replaces old msgs; ack message follows)
           │
        compressor model (cheap)  ──► summarizes everything older
           │                             than the last 5 messages
        sub-agents (any configured model) ──► heavy reading/research
           │                                  in their own context
        caveman mode ──► ~65% fewer output tokens, same substance
        macros ──► long recurring prompts become one word
        lazy skills / lazy MCP ──► schemas cost zero until used
        parallel tool calls ──► one round trip, not five
```

- **Two-model compression** — when history passes ~24k tokens (configurable), everything except the last 5 messages is summarized by the compressor model into a dense block. Main model never sees the bloat. Set both models in onboarding.
- **Sub-agent efficiency** — the main model can call `spawn_agent` with a task and a *different model* (it checks `list_available_models` to see what you configured — e.g. route a simple search to a cheap fast model). Sub-agents get their own context and return a compact report.
- **Lazy everything** — skills (`use_skill`) and MCP tools (`mcp_list_tools` → `mcp_call_tool`) are pulled into context only when actually needed.
- **Parallel tool calls** — independent tool calls execute concurrently, not sequentially.

## Caveman mode (default ON)

Inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT), re-implemented natively. The agent answers in tight fragments — code, commands, paths, and errors stay byte-for-byte exact.

```
/caveman [off|lite|full|ultra|wenyan]
/caveman-help                            # quick reference for all caveman commands   # default: full
/caveman-stats                          # session + lifetime savings
/caveman-compress <file>                # shrink memory files ~46%, forever
/caveman-commit                         # ≤50-char conventional commit from staged diff
/caveman-review                         # one-line review comments on current diff
```

## Providers

OpenAI-compatible core + native Anthropic. Presets in onboarding: Anthropic, OpenAI, OpenRouter, DeepSeek, Groq, Together, Fireworks, Mistral, Cerebras, xAI, Gemini, Ollama, LM Studio, custom. API keys support `${ENV_VAR}` references. Config: `~/.eaon/config.json` (per-project overrides in `.eaon/config.json`).

## Tools & commands

Built-in tools: `read_file`, `write_file`, `edit_file` (diff preview + confirm), `list_files`, `glob`, `grep`, `run_shell` (confirm + allowlist), `web_search` (**DuckDuckGo — no API key**), `web_open`, `todo_write/read`, `spawn_agent`, `list_available_models`, `use_skill`, `mcp_list_tools`, `mcp_call_tool`, `compress_now`.

```
/help /model /models /compress /clear /stats /theme /init /setup /exit
/macro list|set|rm        manage output macros
/permissions confirm|auto|readonly
```

## Macros

Macros are literal reusable text for the AI's responses and file writes. Eaon has **no built-in macros**. The model can create one with the `macro_define` tool (`name`, multiline `text`, optional `description`); Eaon asks permission before saving it. When the model writes `<<macro:license>>`, Eaon replaces that token with the definition before showing the answer or writing the file.

Definitions are stored as structured JSON at `~/.eaon/macros.json`; the `text` field preserves newlines. Set one from the chat input (continue on later lines for a multiline value):

```
/macro set license Copyright (c) 2026 Example Corp.
All rights reserved.
```

The active macro names are listed in the system prompt, so the model can use them directly. Unknown macro tokens are left unchanged rather than silently inventing a built-in.

## MCP servers & plugins

Standard MCP config in `~/.eaon/config.json`:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
  }
}
```

Servers start lazily (first use), discovered via `mcp_list_tools`. **Plugins**: drop a folder in `~/.eaon/plugins/<name>/` with `plugin.json` (extra `mcpServers`, `macros`, `commands`, `themes`) and `skills/<skill>/SKILL.md`. **Custom skills**: `~/.eaon/skills/<name>/SKILL.md` with `name:`/`description:` frontmatter — the model loads them only when relevant.

## Permissions

Default `confirm`: every shell command and file write asks first — `[y]` once, `[a]` always (persisted allowlist), `[n]` deny. Read-only safe commands (`ls`, `git status`, …) skip the prompt. Modes: `confirm` / `auto` / `readonly`.

## Headless

```bash
eaon-agent -p "fix the failing test in src/auth" --stats
eaon-agent -p "summarize this repo" -y -m deepseek-chat   # -y auto-approves, -m model override
```

## Project memory

`/init` generates `EAON.md` (purpose, stack, commands, conventions) — auto-loaded every session, so keep it lean. Global memory: `~/.eaon/EAON.md`.


## TUI workspace

The default `eaon-agent` command opens a full-window terminal workspace inspired by modern coding-agent TUIs:

- responsive top bar and session header — **always fixed on screen**
- **scrollable chat history**: the chrome (top bar, session header, input, status bar) never moves; only the conversation scrolls. Use `PgUp`/`PgDn` to scroll back through history, `PgDn` to return to the live view
- centered welcome screen that uses the available terminal height
- `Enter` to start, `S` to open setup, `Ctrl+C` to quit
- workspace rail on wider terminals with session shortcuts and runtime status
- persistent prompt, token usage, permission state, and cancellation hints
- theme-colored UI with a real tinted terminal background

The chat prompt keeps the existing controls: `↑/↓` for history, `Esc` to clear or cancel, and `\` + `Enter` for multiline input.


## Themes

Choose a terminal palette with `/theme <name>`. Every theme sets accent, border, code, success/error colors **and a real terminal background color**. Included: `eaon` (default), `absolutely` (Claude-inspired), `absolutely-2` (ChatGPT-inspired), `codex` (Codex-inspired), `violet`, `phosphor`, `midnight`, `dracula`, `nord`, `solarized`, `rose-pine`, `ember`, and `ocean`. The choice persists in `~/.eaon/config.json`.

Plugins can ship their own themes (see below) — they show up in `/theme list` with their source plugin.

## Native command plugins

Built-in native commands run the installed CLI directly, with Eaon's normal shell permission policy — no MCP server configuration:

```
/github (gh) /git /docker /npm /node /python /make /cargo /kubectl /terraform
```

`/plugins` lists the built-ins, native commands contributed by plugins, and what each installed plugin provides. A plugin manifest (`~/.eaon/plugins/<name>/plugin.json`) can contribute commands, macros, MCP servers, skills and themes:

```json
{
  "name": "work-tools",
  "commands": {
    "tickets": { "command": "tickets", "description": "Team ticket CLI" }
  },
  "themes": {
    "work-dark": { "name": "Work Dark", "accent": "#7aa2f7", "bg": "#0a0e1a" }
  }
}
```

Use the command as `/tickets list`, the theme as `/theme work-dark`. Command executables cannot contain spaces; arguments are passed directly, not through a shell. Theme fields: `accent` (required), `name`, `description`, `code`, `border`, `success`, `error`, `bg`, `muted`.

## Development

```bash
npm install
npm run build
npm test     # builds, then runs theme/plugin, headless and TUI layout tests
```

The TUI tests render the real app against a fake terminal (offline `echo` provider) and assert the chrome stays fixed and the frame never exceeds the terminal height.

## License

WTFPL
