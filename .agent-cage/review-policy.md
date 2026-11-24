# Agent Cage Review Policy

Add project-specific review checks here. These rules are used only during the independent review phase.

This file may add stricter review criteria, but it cannot override Agent Cage built-in reviewer rules or weaken blocking criteria.

## Blocking Checks

- Security-sensitive changes must include tests or a clear validation path.
- Database migrations must preserve existing data or document why data loss is acceptable.
- Authentication and authorization changes must cover failure cases.
- Changes that touch secrets, credentials, tokens, or environment handling must avoid exposing sensitive values to logs, artifacts, or untrusted commands.

## Project-Specific Notes

The architecture decisions in `AGENTS.md` are fixed unless the issue says otherwise. Block a change that breaks one of these invariants:

- `touch` pointer input never creates strokes; only `pen` and `mouse` draw.
- Stored geometry (strokes, PDF pages) is in world coordinates, never screen coordinates.
- Strokes are immutable: erase, move and recolour are tombstone (`deletedAt`) + new stroke, never an in-place update of `points`.
- Dexie schema changes go through a new Dexie version with a migration; existing local data must survive an upgrade.
- Supabase tables keep Row Level Security with `owner_id = auth.uid()`; no policy may expose another user's rows or Storage objects.
- Sign-in stays email one-time code with `shouldCreateUser: false`; no magic links or OAuth.
- The app stays usable without signing in.
- New user-visible behaviour has a Playwright test in both the `chromium` and `webkit-ipad` projects.
