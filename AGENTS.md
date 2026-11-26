# Whiteboard

A GoodNotes-like handwriting PWA for iPad + Apple Pencil: an infinite canvas, PDF import and annotation, offline-first storage with Supabase sync.

## Commands

| Task | Command |
| --- | --- |
| Dev server | `npm run dev` |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Build | `npm run build` |
| E2E tests | `npm run e2e` (builds, serves `vite preview`, runs Chromium + iPad WebKit) |

All five checks (`lint`, `typecheck`, `test`, `build`, `e2e`) must pass before a change is done.

## Architecture decisions

These were decided up front. Do not change them without an issue that says so.

- **Stack:** Vite + React + TypeScript. The drawing engine is framework-free TypeScript under `src/engine/`; React renders only the UI around it (toolbar, board list, dialogs).
- **Canvas model:** one infinite canvas per board. Everything stored is in **world coordinates** (CSS px at zoom 1). The camera is `{ x, y, zoom }`; convert screen ↔ world only at the input and render boundaries.
- **Input:** `pointerType` `pen` and `mouse` draw; `touch` draws only when the 「手指繪圖」 (finger drawing) toggle is on (`localStorage` `whiteboard:fingerDraw`; default on until the first `pen` pointer turns it off). With it on, one finger draws with the current tool, and a second finger going down discards that stroke; touch is ignored while a pen stroke is in progress. With it off, one finger pans, starting only once it has moved 8 px (`PAN_SLOP_PX`) and then following the full distance. Palm rejection, in both modes: a touch that goes down within 500 ms (`PALM_WINDOW_MS`) of any pen event, hover included, is ignored until it lifts. The board screen and canvas turn off text selection, the long-press callout and `touchstart` defaults, so a resting palm never selects anything. Two fingers always pinch-zoom and pan; trackpad/mouse wheel pans, ctrl/⌘ + wheel zooms. The canvas element has `touch-action: none`. Use `getCoalescedEvents()` when available. A tap (under 4 px) on a video timestamp mark jumps the video there instead of drawing, with any tool but 橡皮擦 and 套索.
- **Rendering:** strokes are stored as raw input points and turned into outlines with `perfect-freehand` at render time. Two stacked canvases: a committed layer (cached, redrawn only on change or camera move) and a live layer that draws only the stroke in progress.
- **Local storage:** IndexedDB through Dexie, schema versioned with Dexie migrations. IDs are `crypto.randomUUID()`; timestamps are epoch milliseconds.

  ```ts
  Board     { id, ownerId: string | null, title, createdAt, updatedAt, deletedAt: number | null }
  Stroke    { id, boardId, ownerId: string | null, tool: 'pen' | 'highlighter', color, size,
              points: [x: number, y: number, pressure: number][],  // world coords, raw samples
              bbox: { minX, minY, maxX, maxY }, createdAt, deletedAt: number | null }
  PdfFile   { id, ownerId: string | null, name, blob, createdAt }   // original PDF, stored once
  PdfPage   { id, boardId, pdfId, pageIndex, x, y, width, height }  // world coords, locked
  Video     { id, boardId, ownerId: string | null, provider: 'youtube', externalId, title,
              createdAt, deletedAt: number | null }
  VideoMark { id, boardId, videoId, ownerId: string | null, t, x, y,
              createdAt, deletedAt: number | null }
  ```

- **Strokes, videos and timestamp marks are immutable.** Erasing or removing sets `deletedAt` (a tombstone); moving or recolouring a stroke, or moving a mark, is tombstone + new row. Undo/redo works in those terms. Queries hide tombstoned rows.
- **PDF:** `pdfjs-dist` renders pages; `PdfPage` elements sit under strokes and cannot be moved. Annotated-PDF export assigns a stroke to every page whose rectangle its `bbox` intersects.
- **Video:** YouTube only, through the official IFrame API loaded lazily from `https://www.youtube.com/iframe_api` with host `youtube-nocookie.com`. Players live in a docked panel, never on the canvas. E2E tests use `mockYouTube` (`e2e/fake-youtube.ts`) and never reach YouTube.
- **Sync (Supabase):** offline-first. Dexie is the source of truth; writes go to Dexie first, then an outbox pushes them. Pull is incremental by a server-assigned `synced_at` cursor (set by a trigger on every insert and update; distinct from the client's `updatedAt`). PDF blobs go to Supabase Storage at `{ownerId}/{pdfId}.pdf`. Every table enforces `owner_id = auth.uid()` with Row Level Security.
- **Auth:** email one-time code only (`signInWithOtp` with `shouldCreateUser: false`, then `verifyOtp` with `type: 'email'`). No magic links or OAuth: an installed iPad PWA does not share storage with Safari. The app must stay fully usable without signing in (local-only mode).
- **Config and secrets:** Supabase settings come from `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Never commit real keys or `.env` files; `.env.example` is fine.

## Testing

- Unit tests: Vitest + jsdom, next to the code as `*.test.ts(x)`. Use `fake-indexeddb` for Dexie. Prefer testing the engine's pure functions (geometry, hit-testing, camera math, layout) directly.
- E2E tests: Playwright in `e2e/`, projects `chromium` and `webkit-ipad`. Simulate Apple Pencil by dispatching `PointerEvent`s with `pointerType: 'pen'` and a `pressure` on the canvas; simulate fingers with `pointerType: 'touch'`.
- E2E tests read app state through a read-only `window.__whiteboard` snapshot rather than pixels where possible. Extend it when a feature needs new observable state.
- Every issue with user-visible behaviour adds or extends a journey under `e2e/journeys/` (`*.journey.ts`, the `journey` project) that walks through it like a user, with paced steps and about 0.5 s pauses. Keep each journey under about 20 s. Journeys are recorded as video and turned into GIFs by `scripts/journey-gif.mjs` for the PR's Evidence section. A journey's test title is burned into its GIF as a caption: write it in English as `<Feature>: <what the user does> → <what they see>`, in about 40 characters or fewer, the way the existing journeys do.
- Real Apple Pencil feel and latency cannot be automated; say in the PR's **How to use** what a reviewer should try on an iPad.

## Pull requests

Every PR description has a **Change map** and a **How to use** section.

- **Change map:** which public interfaces changed; from which entry point (key, gesture, command, route, event) the flow goes through which interface to which changed functions; other changed functions; then the file list. Write "None" for empty items.
  - **Interfaces** are the contracts the project exposes to users or other code: UI gestures and controls, the stored data schema (Dexie / Supabase), `window.__whiteboard`, environment variables, and types and functions imported across files.
  - **Flows** are Mermaid `sequenceDiagram`s, one per entry point. Participants are the user, the modules holding the interfaces, and external programs (IndexedDB, Supabase). Messages follow the real call order with function names and key data, one call or fact per message: where a message would need a semicolon, write two messages, because GitHub's Mermaid parser rejects `;` in message text. Use `alt`/`opt` for branches, `loop` for loops, and `rect` to highlight new or changed parts. Flows are derived statically and may miss dynamic calls; they are a reading aid, not a review result.
  - **Header and file table:** the header is the first line under `## Change map`, outside the `<details>` block. `<base>` is the PR's base branch (`main`) and `<branch>` is the PR's head branch, each with its short sha. Build the counts and the file table (status, +/−, path) from `git diff --numstat` / `--name-status` `<base>...<branch>` at the final head commit, so they match the diff GitHub shows. The skeleton:

    ````markdown
    ## Change map

    `main (0f709c6) → agent-cage/gh-29-run-202611241409 (4609356) · 11 files · +231 −12`

    **Interfaces** …

    **Flows** …

    **Other changed functions** …

    **Files**

    <details>
    <summary>11 files · +231 −12</summary>

    | Status | +/− | Path |
    |---|---:|---|
    | Added | +55/−0 | `scripts/journey-gif-lib.mjs` |
    | Modified | +1/−1 | `AGENTS.md` |

    </details>

    ## How to use
    ````
- **How to use:** how a reviewer actually tries the change: the start command, what to tap, draw or press, and what they should see. With no user-visible behaviour, say so and say how to verify it (for example, which tests to run).
