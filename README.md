# obsidian-crdt-sync

[![Build Status](https://github.com/yegor-usoltsev/obsidian-crdt-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/yegor-usoltsev/obsidian-crdt-sync/actions)
[![GitHub Release](https://img.shields.io/github/v/release/yegor-usoltsev/obsidian-crdt-sync?sort=semver)](https://github.com/yegor-usoltsev/obsidian-crdt-sync/releases)

> ⚠️ **Early development** — This plugin is in active early development. Use at your own risk and **back up your vault before enabling it**.

An [Obsidian](https://obsidian.md) plugin that syncs your vault in real time across devices through your own self-hosted [obsidian-crdt-sync-server](https://github.com/yegor-usoltsev/obsidian-crdt-sync-server). Supports notes, folders, and attachments with offline editing, conflict recovery, and optional Git backup.

![Demo](https://raw.githubusercontent.com/yegor-usoltsev/obsidian-crdt-sync/refs/heads/main/.github/demo.gif)

## What you get

- **Hybrid sync by file type**: text notes use CRDT (Yjs) for collaborative merging, binary files sync as verified blobs, and settings files use deterministic merge policies — each file type gets the right sync strategy.
- **Selective settings sync**: supported `.obsidian` files (app settings, appearance, hotkeys, core/community plugin state, plugin packages, themes, snippets) sync with explicit per-file merge policies. Workspace state is excluded.
- **Stable file identity**: files have identity independent of their path, so renames and moves don't break sync history or create duplicates.
- **Server-authoritative metadata**: the server owns file identity, paths, kinds, and structural invariants. Clients submit intents and receive authoritative results.
- **Offline durability**: local sync state persists in IndexedDB, surviving restarts. Offline edits are captured and replayed on reconnect.
- **History and restore**: the server maintains append-only history. Restore creates a new canonical head rather than mutating history in place.
- **Conflict preservation**: when local data can't be safely reconciled, it's preserved as `.sync-conflict-{timestamp}-{hostname}` artifacts — never silently discarded.
- **Repair and diagnostics**: command-palette actions for full sync, rebootstrap, index rebuild, current-file restore, and diagnostics export (JSON to vault root).
- **Overwrite safety guard**: the plugin re-stats local files before writing remote content, aborting if the file changed during the apply window.
- **Git backup**: the companion server can export canonical vault state to a Git repository on a schedule, with worktree safety and redundant-backup skipping.
- **Self-hosted**: your vault data stays on infrastructure you control, with durable SQLite storage and content-addressed binary blob reuse.

## Installation

The plugin is not yet listed in the Obsidian Community Plugins directory. Install manually:

1. Download `main.js`, `manifest.json`, `styles.css`, and `versions.json` from the [latest release](https://github.com/yegor-usoltsev/obsidian-crdt-sync/releases).
2. Copy them to your vault's config plugins folder (usually `<vault>/.obsidian/plugins/crdt-sync/`).
3. Enable the plugin under **Settings → Community plugins**.

## Configuration

Open **Settings → Real-Time CRDT Sync** and fill in:

| Setting           | Description                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **Server URL**    | WebSocket URL of your server, e.g. `wss://sync.example.com`. Use `ws://` for localhost only.           |
| **Auth Token**    | Shared secret matching `AUTH_TOKEN` on the server (min 32 chars). Stored in Obsidian's secure storage. |
| **Debug logging** | Enable verbose console logs for troubleshooting.                                                       |

After saving, the plugin connects automatically. Sync status is shown in the status bar (`CRDT Sync: connected`, `CRDT Sync: syncing`, `CRDT Sync: offline`, `CRDT Sync: error`). Click the status bar item or use the command palette to run a full sync.

## Architecture

The plugin uses a hybrid sync architecture:

| File class | Sync strategy | Transport |
| --- | --- | --- |
| Text notes (`.md`, `.txt`, etc.) | CRDT/Yjs per-file documents | WebSocket (Hocuspocus) |
| Binary files (images, PDFs, etc.) | Snapshot/blob with digest verification | HTTP upload/download |
| Settings files (`.obsidian/*`) | Snapshot with per-file merge policies | HTTP upload/download |

**Plugin modules**: control-surface, local-store (IndexedDB), policy-engine, metadata-client, text-sync, blob-sync, settings-sync, bootstrap-repair.

**Server modules**: transport (auth/health/WebSocket), metadata-registry, history, text-doc-service, blob-store, settings-store, backup (Git).

## Sync behavior

When a device connects, it resolves canonical metadata first (file identities, paths, kinds), then binds text documents and materializes binary/settings content. Text edits use diff-based bridging between the filesystem and CRDT state. Vault events are debounced (350ms create settle, 300ms modify) with directory rename/delete child suppression. Retry backoff is per-path exponential (5s × 2^failures, 5min cap). Files exceeding 200 MB are skipped.

## Risks and security

- **Data loss**: This is early-stage software. Bugs in sync logic could corrupt or lose vault data. Always maintain independent backups.
- **Server trust**: All vault content is transmitted to and stored on your self-hosted server in plaintext (beyond TLS). Whoever controls the server can read your entire vault.
- **Network and file access**: The plugin continuously reads and writes vault files and sends synced content to your configured server. It does not include telemetry, ads, or third-party analytics.
- **TLS required**: Always use `wss://` for remote servers. The plugin enforces this and rejects `ws://` for non-localhost addresses.
- **Auth token**: The shared token is the only authentication factor. Use a strong random value generated during server setup and keep it secret. It is stored in Obsidian's secure storage and never written to the data file.
- **Protocol stability**: The sync protocol and storage format may change in breaking ways between releases while the project is in early development.

## Releasing

Create a release from a clean `main` branch:

```sh
bun run release patch
# or: bun run release minor
# or: bun run release major
```

The local release script updates `manifest.json` and `versions.json`, creates a `Release: X.Y.Z` commit, creates the matching `X.Y.Z` Git tag, and pushes both `main` and the tag to GitHub.

The GitHub Actions release workflow then runs [GoReleaser](https://goreleaser.com/) on that tag. GoReleaser installs dependencies, builds `main.js`, creates the GitHub release, and uploads `main.js`, `manifest.json`, `styles.css`, and `versions.json` as release assets.

For a local dry run of the release packaging:

```sh
goreleaser release --snapshot --clean
```

## Versioning

This project uses [Semantic Versioning](https://semver.org). Release tags use the same `X.Y.Z` version format as `manifest.json` and `versions.json`, as required by Obsidian community plugins.

## Contributing

Pull requests are welcome. For larger changes, open an issue first so the release format, protocol compatibility, and migration impact can be discussed before implementation.

## License

[MIT](https://github.com/yegor-usoltsev/obsidian-crdt-sync/blob/main/LICENSE)
