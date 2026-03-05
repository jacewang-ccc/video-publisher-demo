# Architecture (MVP)

## Components

- Web panel (`apps/web`): single-user UI, config editor, preview matrix, snapshot lock, publish orchestration.
- Shared package (`packages/shared`): snapshot schema + validation helpers.
- Extension (`apps/extension`): orchestrator + per-platform connectors.

## Key concepts

- **Draft**: a canonical, platform-agnostic representation of what will be published.
- **Adapter**: platform constraints + mapping from Draft to platform payload.
- **Connector**: executes Prepare/Commit on the real platform publish page (content script).
- **Snapshot**: immutable “frozen” per-platform final fields used for this publish run.
- **2-phase publish**: Prepare fills pages and gets them ready; Commit clicks publish.

