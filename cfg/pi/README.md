# Pi Configuration (dotfiles)

This directory contains reusable Pi resources managed by this nix-dotfiles repo.

- `settings.json`, `presets.json`, `keybindings.json`, `models.json`: global Pi config seeds
- `AGENTS.md`: global Pi agent defaults copied to `~/.pi/agent/AGENTS.md`
- `extensions/`: TypeScript extensions loaded by Pi from this repo
- `prompts/`: slash prompt templates loaded by Pi from this repo
- `agents/`: lean subagent definitions copied to `~/.pi/agent/agents`
  - `scout` = cheap/fast read-only recon
  - `expert` = expensive/smart read-only advice, planning, and review
- `memory/`: global memory copied to `~/.pi/agent/memory`
- `skills/`: custom skills copied to `~/.pi/agent/skills`
- `themes/`: custom themes, including `gruvbox-dark`

## Sync

Run:

```bash
./cfg/pi/sync-to-home.sh
```

The script copies global config files, agents, memory, and skills into
`~/.pi/agent` (or `$PI_CODING_AGENT_DIR`). Extensions/prompts/themes are loaded
directly from this repo via absolute paths in `settings.json`:

- `/Users/ludwig/dev/nix-dotfiles/cfg/pi/extensions`
- `/Users/ludwig/dev/nix-dotfiles/cfg/pi/prompts`
- `/Users/ludwig/dev/nix-dotfiles/cfg/pi/themes`

The script intentionally does **not** copy transient or sensitive Pi state such
as `auth.json`, `sessions/`, `activity/`, usage logs, or debug logs.

## Included custom pieces

- `status-bar-v2.ts`: compact footer/status with model/auth context
- `history-search-v2.ts`: prompt/session history search
- `grouped-tools-v2.ts`: grouped tool display
- `session-ux-v2.ts`: auto titles and recent sessions
- `vcs-status-v2.ts`: jj/git footer and topology helpers
- `review-v2.ts`: review findings tools and summaries
- `inprocess-tools.ts`: Node-based grep/find replacements to avoid process-spawn pressure
- `context-compressor/`: recall-informed compaction trigger using `settings.compression`
- `signal-trimmer/`: high-signal context trimming with pressure warnings
- `structured-checkpoint/`: stricter compaction checkpoint summaries
- `claude-work-oauth.ts`: optional Claude work OAuth provider
- `pi-memory.ts`: project/global memory tools
- `preset.ts`: `--preset` flag and `/preset` command backed by `presets.json`
- `subagent/`: `subagent` tool used by scout/expert prompt flows
- `pi-autoresearch/`: autonomous experiment-loop tools, activated by `/autoresearch`

## Quick usage

- `pi --preset worker -c` → normal implementation loop
- `pi --preset safe --no-session` → read-only analysis
- Use `subagent` with `scout` for cheap recon and `expert` for smart second opinions
- `/planflow <task>` → scout → expert recommendation (no automatic implementation)
- `/scout-and-plan <task>` → same lean advisory flow
- `/recent-v2` → recent sessions
- `/review` and `/review-summary` → collect/review findings
- `/autoresearch <goal>` → enter the experiment-loop workflow
