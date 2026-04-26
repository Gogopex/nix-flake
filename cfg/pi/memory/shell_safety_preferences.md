---
timestamp: 2026-04-05T18:55:00.616Z
session: 87423d7d
scope: global
---
# Shell safety preferences

- Prefer `rg`, `fd`, and targeted path checks over `find`, especially on large or degraded filesystems.
- Never unmount local or remote volumes without explicit user approval.
- Avoid broad filesystem scans when the system is already slow or under I/O pressure.
- For mount- or cache-related debugging, prefer minimal, user-run commands before any potentially disruptive action.
