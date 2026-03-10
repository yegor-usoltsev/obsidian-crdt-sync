import ignore from "ignore";
import { normalize } from "pathe";

export const SYNC_IGNORE_LIST = `# Managed by obsidian-crdt-sync
._*
.apdisk
.AppleDB
.AppleDesktop
.AppleDouble
.com.apple.timemachine.donotpresent
.directory
.DocumentRevisions-V100
.dropbox
.dropbox.attr
.dropbox.cache
.DS_Store
.fseventsd
.fuse_hidden*
.git/
.LSOverride
.nfs*
.obsidian/
.Spotlight-V100
.TemporaryItems
.Trash-*
.trash/
.Trashes
.VolumeIcon.icns
[Dd]esktop.ini
*.icloud
*.lnk
*.orig
*.stackdump
*~
$RECYCLE.BIN/
ehthumbs_vista.db
ehthumbs.db
Thumbs.db
Thumbs.db:encryptable
`;

export const SYNC_IGNORE_RESERVED_PATH = ".gitignore";

const syncIgnore = ignore().add(SYNC_IGNORE_LIST);

function normalizeVaultPath(path: string): string {
  return normalize(path).split("\\").join("/");
}

export function isIgnoredSyncPath(
  path: string,
  kind: "file" | "directory",
): boolean {
  const normalizedPath = normalizeVaultPath(path);
  return (
    normalizedPath === SYNC_IGNORE_RESERVED_PATH ||
    syncIgnore.ignores(normalizedPath) ||
    (kind === "directory" && syncIgnore.ignores(`${normalizedPath}/`))
  );
}
