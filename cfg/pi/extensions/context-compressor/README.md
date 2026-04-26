# Context Compressor Extension

Automatic context compression for pi that uses `recall` to intelligently summarize conversations while preserving important information.

## Features

- **Automatic compression**: Triggers when context approaches token limit (default: 190k tokens)
- **Advance warning**: Alerts at 80% of threshold (default: 160k tokens)
- **Smart summarization**: Uses `recall search` to find key decisions, errors, files modified
- **Manual control**: Run `/compact` to compress immediately (built-in pi command)
- **Configurable**: Adjust thresholds, search terms, and custom instructions
- **Preserves everything**: Original messages remain in session file, only excluded from LLM context

## How It Works

1. Monitors each turn for token usage
2. When approaching limit, hooks into `session_before_compact` event
3. Uses `recall search` to find:
   - Decision points
   - Errors and fixes
   - File modifications
   - Important patterns
4. Injects search results as additional context for pi's default summarizer
5. Keeps recent messages in full (default: last 10 turns)

## Configuration

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "compression": {
    "enabled": true,
    "warnThreshold": 160000,
    "compressThreshold": 190000,
    "keepLastTurns": 10,
    "searchTerms": [
      "decision",
      "agreed",
      "error",
      "bug",
      "fix",
      "important",
      "conclusion",
      "plan"
    ],
    "customInstructions": "Focus on decisions made, files modified, errors encountered and resolved, and the current direction of work."
  }
}
```

### Settings

- `enabled`: Turn compression on/off (default: `true`)
- `warnThreshold`: Tokens to warn user (default: `160000`)
- `compressThreshold`: Tokens to auto-compress (default: `190000`)
- `keepLastTurns`: Number of recent messages to keep in full (default: `10`)
- `searchTerms`: Keywords to search for in conversation (default: `["decision", "agreed", "error", "bug", "fix", "important", "conclusion", "plan"]`)
- `customInstructions`: Instructions for the summary generation AI

## Commands

### `/compact [instructions]`

Manually trigger context compression now (built-in pi command). The extension automatically adds recall search context to all compactions.

## Requirements

- **recall CLI**: Must be installed and available in `$PATH`
- **Session storage**: pi must be using persistent sessions (default)

### Installing recall

```bash
# Clone and build
cd ~/dev
git clone <recall-repo-url>
cd recall
cargo build --release
cp target/release/recall ~/.local/bin/recall

# Verify
recall sources
```

## Example Output

```
[Context compressor] Warning: 160000/190000 tokens (84% full)
  Run /compact now, or auto-compress at 190000 tokens

[Context compressor] Auto-compressing session a1b2c3d4...
[Context compressor] Searched 50 turns, found relevant context
[Context compressor] Keeping last 10 turns in full
[Context compressor] ✓ Context compressed: 15000 tokens (185000 → 15000, saved 91.9%)
```

## Recovering Original Context

Since the compaction only excludes messages from LLM context, you can always retrieve the full conversation:

```bash
recall show <session_id>
```

Or within pi, the session file contains all messages permanently.

## Testing

Test that recall search works with your sessions:

```bash
# List sessions
recall sessions --limit 5 --sort newest

# Search within a specific session
recall search "error" --session-id <session-id> --compact --limit 5
```

## Troubleshooting

### Compression not triggering

1. Check `recall` is installed: `which recall`
2. Verify recall works: `recall sources`
3. Verify settings: Check `~/.pi/agent/settings.json`
4. Check extension is loaded: Run pi and look for extension in logs

### Summary generation failed

The extension falls back to a simple summary if AI generation fails. The original context is still preserved in the session file.

### Tokens still high after compression

Adjust `keepLastTurns` downward (e.g., to 5) to keep fewer recent messages in full.

## Development

The extension subscribes to `message_end` events to track token usage and trigger compression at the configured threshold.

Key files:
- `extension.ts`: Main extension logic
- `package.json`: Extension metadata
- `README.md`: This file
