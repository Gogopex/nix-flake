---
description: scout + expert in a specific workspace (first arg = cwd)
---
Run a two-agent advisory flow in this workspace:

Workspace (cwd):
$1

Task:
${@:2}

Use `subagent` in chain mode with `cwd: "$1"` for every step:
1. `scout` for cheap recon
2. `expert` for smart recommendation/review using `{previous}`

Do not implement automatically. Final output: relevant files, recommendation, validation, remaining risks.
