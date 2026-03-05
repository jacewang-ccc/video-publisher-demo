# Multi-Platform Video Publisher (MVP Scaffold)

This repo is a flexible scaffold for a **single-user** MVP:

- Web panel: create content, configure templates/rules, preview per-platform final fields, lock snapshot, and trigger publish.
- Browser extension (MV3): prepares platform pages (upload/fill/settings) after snapshot lock, then commits publish on one click.

## Repo layout

- `docs/PRD.md`: product requirements (human-readable, dev-actionable)
- `config/`: editable defaults (types, templates, rules, schedule policy)
- `apps/web/`: no-build web panel (static HTML/JS) for MVP demos
- `apps/extension/`: Chrome/Edge extension skeleton (message passing + stubs)
- `packages/shared/`: shared snapshot schema + helpers

## Running (local demo)

1) Serve the web app:

```bash
cd apps/web
python3 -m http.server 5173
```

2) Load the extension:

- Chrome/Edge → Extensions → Enable Developer mode
- Load unpacked → select `apps/extension`

3) Open the web panel:

- `http://localhost:5173`

The demo simulates “Prepare” and “Commit” flows and shows where real connectors integrate.

## GitHub Pages (public demo)

If GitHub Pages is enabled for this repository, open the deployed site and load the extension separately for the full end-to-end demo.
