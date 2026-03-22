/**
 * Echo prevention: tracks locally-written paths to prevent vault-event
 * re-entry during remote materialization.
 */

export class EchoPrevention {
  private writtenPaths = new Set<string>();
  private deletedPaths = new Set<string>();
  private renamedPaths = new Map<string, string>(); // oldPath → newPath

  /** Mark a path as being written by remote sync. */
  markWritten(path: string): void {
    this.writtenPaths.add(path);
  }

  /** Mark a path as being deleted by remote sync. */
  markDeleted(path: string): void {
    this.deletedPaths.add(path);
  }

  /** Mark a rename as initiated by remote sync. */
  markRenamed(oldPath: string, newPath: string): void {
    this.renamedPaths.set(oldPath, newPath);
  }

  /** Check if a write event should be suppressed (is an echo). */
  consumeWrite(path: string): boolean {
    if (this.writtenPaths.has(path)) {
      this.writtenPaths.delete(path);
      return true;
    }
    return false;
  }

  /** Check if a delete event should be suppressed (is an echo). */
  consumeDelete(path: string): boolean {
    if (this.deletedPaths.has(path)) {
      this.deletedPaths.delete(path);
      return true;
    }
    return false;
  }

  /** Check if a rename event should be suppressed (is an echo). */
  consumeRename(oldPath: string, newPath: string): boolean {
    const expected = this.renamedPaths.get(oldPath);
    if (expected === newPath) {
      this.renamedPaths.delete(oldPath);
      return true;
    }
    return false;
  }

  /** Clear all tracking state. */
  clear(): void {
    this.writtenPaths.clear();
    this.deletedPaths.clear();
    this.renamedPaths.clear();
  }
}
