# structured-checkpoint

Custom compaction extension for pi that produces a stricter checkpoint focused on preserving exact working state.

Current implementation note: the prototype now uses a runtime-safe heuristic checkpoint builder rather than an extra LLM call during compaction.

## Goals

- keep compaction summaries more useful for coding work
- preserve exact file paths, commands, and recent errors when possible
- emit both human-readable prose and machine-readable structured state
- stay simple and debuggable

## Status

Validated baseline prototype.

### Validation result

Tested against the installed pi runtime and adapted for the normal `pi` entrypoint.

Confirmed baseline properties:
- extension discovery works from the `structured-checkpoint/` directory
- extension imports cleanly
- synthetic `session_before_compact` execution exits cleanly
- no extension runner errors were emitted during the harness run

Current behavior note:
- the prototype builds a structured checkpoint heuristically from recent session messages and file-operation metadata
- it ignores prior checkpoint blocks to avoid recursive stale summaries
- it prefers recent user turns when deriving the goal, blockers, and next actions
- it compresses noisy failures into compact error signatures
- it records repeated validation probes such as duplicate reads and duplicate bash failures
- it falls back to the previous structured JSON state when a compaction pass has too little fresh signal
- it does not require a separate compaction-time model call
- it persists structured state in `details` and `preserveData`

## Config

Add to `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "structuredCheckpoint": {
    "enabled": false,
    "model": "current",
    "maxTokens": 8192,
    "includeRecentContext": true,
    "debug": false
  }
}
```

Note: `model` and `maxTokens` are currently retained for forward compatibility, but the runtime-safe heuristic prototype does not use a separate compaction-time model call.

## Rollback

1. Set `structuredCheckpoint.enabled` to `false`
2. Stop loading the extension or run `/reload`
