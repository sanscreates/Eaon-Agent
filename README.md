# Eaon Agent — v1.3

**Token-efficient terminal AI coding agent.** Connect whatever providers you want. Two-model architecture: a strong **main** model does the agentic work, a cheap **compressor** model eats the context. Caveman mode on by default. macOS + Linux.

> why use many tokens when few do the trick


## Changelog

### v1.3.0
- **Escape to cancel** — press Escape during any running task to interrupt it and return to the prompt

### v1.2.0
- Welcome screen with randomized ML/AI quotes on launch
- `/update` command shows curl-based upgrade instruction
- Theme selector placeholder (amber/emerald/slate/sky)
- Tool result cache — identical shell/glob/grep/file calls cached for 30s
- Compression threshold lowered 24k → 20k tokens

### v1.1.0
- Context window fix — README diagram now accurately shows actual messages sent
- Welcome screen + quote box replaces cube eyes mascot
- Theme selector overlay
- Auto-update — `/update` checks npm; install.sh notifies on upgrades
- Efficiency — tool result cache 30s TTL, compression threshold lowered

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

Built-in tools: `read_file`, `write_file`, `edit_file` (diff preview + confirm), `list_files`, `glob`, `grep`, `run_shell` (confirm + allowlist), `web_search` (**DuckDuckGo — no API key**), `web_open`, `todo_write/read`, `spawn_agent`, `list_available_models`, `use_skill`, `mcp_list_tools`, `mcp_call_tool`, `macro_run`, `compress_now`.

```
/help /model /models /compress /clear /stats /init /setup /exit
/m <name> [args]          run a macro        /macro add|rm|list
/permissions confirm|auto|readonly
```

## Macros

Save tokens on prompts you repeat. Builtins: `/review /fix /test /explain /optimize /docs /commit /refactor`. Add your own:

```
/macro add shipit Run tests, fix failures, then commit with a conventional message: {{args}}
```

Stored in `~/.eaon/macros.json` — also available to the model via `macro_run`.

## MCP servers & plugins

Standard MCP config in `~/.eaon/config.json`:

```json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" } }
  }
}
```

Servers start lazily (first use), discovered via `mcp_list_tools`. **Plugins**: drop a folder in `~/.eaon/plugins/<name>/` with `plugin.json` (extra `mcpServers`, `macros`) and `skills/<skill>/SKILL.md`. **Custom skills**: `~/.eaon/skills/<name>/SKILL.md` with `name:`/`description:` frontmatter — the model loads them only when relevant.

## Permissions

Default `confirm`: every shell command and file write asks first — `[y]` once, `[a]` always (persisted allowlist), `[n]` deny. Read-only safe commands (`ls`, `git status`, …) skip the prompt. Modes: `confirm` / `auto` / `readonly`.

## Headless

```bash
eaon-agent -p "fix the failing test in src/auth" --stats
eaon-agent -p "summarize this repo" -y -m deepseek-chat   # -y auto-approves, -m model override
```

## Project memory

`/init` generates `EAON.md` (purpose, stack, commands, conventions) — auto-loaded every session, so keep it lean. Global memory: `~/.eaon/EAON.md`.

## Changelog

### v1.1.0
- **Accurate context window** — architecture diagram now shows what's actually sent (system + compressed block + ack + last N msgs)
- **Cube eyes TUI** — orange-themed interface with a blinking cube-with-eyes mascot in the footer
- **Auto-update** — `/update` command checks npm for newer versions; install script notifies on upgrade
- **Tool result cache** — identical shell/glob/grep/file calls cached for 30 s (reduces waste on repeated commands)
- **Compress threshold lowered** — default compression trigger from ~24k → ~20k tokens (compress earlier, stay leaner)

## License

GPL-3.0 — see [LICENSE](./LICENSE). Caveman-style compression idea credit: [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT).

GPL-3.0 — see [LICENSE](./LICENSE). Caveman-style compression idea credit: [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (MIT).
