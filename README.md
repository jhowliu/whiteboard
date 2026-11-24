# Whiteboard

A GoodNotes-like handwriting PWA for iPad + Apple Pencil: an infinite canvas, PDF import and annotation, and offline-first storage with Supabase sync.

## Development

```bash
npm install
npm run dev
```

To try it on an iPad over Tailscale:

```bash
npm run dev
tailscale serve --bg 5173   # https://<machine>.<tailnet>.ts.net
```

See [AGENTS.md](AGENTS.md) for commands, architecture decisions and PR rules.
