# obsidian-crdt-sync

[![Build Status](https://github.com/yegor-usoltsev/obsidian-crdt-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/yegor-usoltsev/obsidian-crdt-sync/actions)
[![GitHub Release](https://img.shields.io/github/v/release/yegor-usoltsev/obsidian-crdt-sync?sort=semver)](https://github.com/yegor-usoltsev/obsidian-crdt-sync/releases)

> ⚠️ **Early development** — This plugin is in active early development. Use at your own risk and **back up your vault before enabling it**.

An [Obsidian](https://obsidian.md) plugin that syncs your vault across devices in real time using [Yjs](https://github.com/yjs/yjs) conflict-free replicated data types (CRDTs). Requires a self-hosted [obsidian-crdt-sync-server](https://github.com/yegor-usoltsev/obsidian-crdt-sync-server).

![Demo](https://raw.githubusercontent.com/yegor-usoltsev/obsidian-crdt-sync/refs/heads/main/.github/demo.gif)

## Installation

The plugin is not yet listed in the Obsidian Community Plugins directory. Install manually:

1. Download `main.js`, `manifest.json`, and `versions.json` from the [latest release](https://github.com/yegor-usoltsev/obsidian-crdt-sync/releases).
2. Copy them to `<vault>/.obsidian/plugins/crdt-sync/`.
3. Enable the plugin under **Settings → Community plugins**.

## Configuration

Open **Settings → CRDT Sync** and fill in:

| Setting           | Description                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| **Server URL**    | WebSocket URL of your server, e.g. `wss://sync.example.com`. Use `ws://` for localhost only.           |
| **Auth Token**    | Shared secret matching `AUTH_TOKEN` on the server (min 32 chars). Stored in Obsidian's secure storage. |
| **Debug logging** | Enable verbose console logs for troubleshooting                                                        |

After saving, the plugin connects automatically. Sync status is shown in the status bar (`Sync: ok`, `Sync: syncing`, `Sync: offline`, `Sync: error`). Use the ribbon icon or **Run full sync** command to force a full reconciliation.

## How it works

- **Content**: Each file is stored as a [Yjs](https://github.com/yjs/yjs) document on the server. Text files use collaborative `Y.Text` (character-level CRDT merging); binary files are stored as opaque byte snapshots — last write wins.
- **Metadata**: File paths, renames, and deletes are managed via a server-authoritative ordered event log. The server validates every operation and is the single source of truth for file identity and naming.
- **Transport**: Sync happens over WebSocket via [Hocuspocus](https://tiptap.dev/docs/hocuspocus/introduction). On connect the plugin performs a full reconciliation between local vault state and server state.
- **Conflicts**: Local data is preserved as `.sync-conflict-<timestamp>` copies. Files are never silently overwritten or deleted.
- **Offline**: Pending content changes are queued locally and flushed on reconnect.
- **File size**: Files larger than 90 MB are skipped.
- **Ignored paths**: `.obsidian/`, `.git/`, and OS/editor noise files are never synced.

## Risks and security

- **Data loss**: This is early-stage software. Bugs in sync logic could corrupt or lose vault data. Always maintain independent backups.
- **Server trust**: All vault content is transmitted to and stored on your self-hosted server in plaintext (beyond TLS). Whoever controls the server can read your entire vault.
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

The local release script updates `manifest.json` and `versions.json`, creates a `release: vX.Y.Z` commit, creates the matching Git tag, and pushes both `main` and the tag to GitHub.

The GitHub Actions release workflow then runs [GoReleaser](https://goreleaser.com/) on that tag. GoReleaser installs dependencies, builds `main.js`, creates the GitHub release, and uploads `main.js`, `manifest.json`, and `versions.json` as release assets.

For a local dry run of the release packaging:

```sh
goreleaser release --snapshot --clean
```

## Versioning

This project uses [Semantic Versioning](https://semver.org). Release tags use the `vX.Y.Z` format, while the plugin manifest uses the plain `X.Y.Z` version string required by Obsidian.

## Contributing

Pull requests are welcome. For larger changes, open an issue first so the release format, protocol compatibility, and migration impact can be discussed before implementation.

## License

[MIT](https://github.com/yegor-usoltsev/obsidian-crdt-sync/blob/main/LICENSE)
