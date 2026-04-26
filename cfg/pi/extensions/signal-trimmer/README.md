# signal-trimmer

A simple-first pi extension prototype for keeping signal high and context fat low.

## Goals

- trim stale tool output before each LLM call
- keep recent turns verbatim
- preserve key error lines from bash output
- preserve exact file paths in read summaries
- deduplicate repeated reads and repeated bash outputs
- warn when context pressure rises
- optionally auto-compact only at high pressure
- optionally inject a visible session message before auto-compaction

## Status

Validated baseline prototype.

### Validation result

Tested against the installed Pi runtime using a synthetic extension runner harness.

Confirmed:
- extension discovery works from the `signal-trimmer/` directory
- extension imports cleanly
- `context` event trimming runs successfully
- `turn_end` pressure logic runs successfully
- optional auto-compaction path fires successfully
- no extension runner errors were emitted during the harness run

Confirmed in the refinement pass:
- `read` summaries now preserve exact file paths
- repeated reads of the same file are deduplicated
- repeated identical bash outputs are deduplicated
- retained bash summaries now include command + head + tail + key error lines
- pressure status line updates successfully when enabled

## Design

This extension combines the best parts of earlier local prototypes:

- `context-trimmer` for live context trimming on the `context` event
- `context-compressor` for pressure thresholds and optional auto-compaction

It is intentionally simple:

- no vector retrieval
- no extra LLM calls on the hot path
- no session mutation
- no artifact store yet

## Config

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "signalTrimmer": {
    "enabled": false,
    "keepRecentTurns": 12,
    "summaryMaxChars": 280,
    "bashErrorLines": 5,
    "bashHeadLines": 3,
    "bashTailLines": 5,
    "deduplicateReads": true,
    "deduplicateBashOutputs": true,
    "stripOldThinking": false,
    "warnPercent": 0.75,
    "compactPercent": 0.9,
    "minTurnsBetweenAutoCompact": 3,
    "autoCompact": false,
    "showStatusLine": true,
    "showAutoCompactMessage": false,
    "debug": false
  }
}
```

## Rollback

1. Set `signalTrimmer.enabled` to `false`
2. Stop loading the extension or run `/reload`
