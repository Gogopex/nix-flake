---
description: scout recon -> expert plan/review (no implementation)
---
Use the `subagent` tool in chain mode with agents `scout` and `expert`.

Task:
$@

Flow requirements:
1. `scout` cheaply gathers relevant code context and constraints.
2. `expert` uses `{previous}` to produce a high-quality plan/review/recommendation.

Do not implement automatically. Return the expert recommendation and ask before making changes unless the user already explicitly requested implementation.
