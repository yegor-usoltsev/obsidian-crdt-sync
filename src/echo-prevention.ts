export class EchoPrevention {
  private writing = new Set<string>();
  private locallyDeleted = new Set<string>();

  markWriting(path: string): void {
    this.writing.add(path);
  }

  unmarkWriting(path: string): void {
    this.writing.delete(path);
  }

  isWriting(path: string): boolean {
    return this.matches(this.writing, path);
  }

  markLocallyDeleted(path: string): void {
    this.locallyDeleted.add(path);
  }

  unmarkLocallyDeleted(path: string): void {
    this.locallyDeleted.delete(path);
  }

  isLocallyDeleted(path: string): boolean {
    return this.matches(this.locallyDeleted, path);
  }

  private matches(paths: Set<string>, candidate: string): boolean {
    for (const path of paths) {
      if (candidate === path || candidate.startsWith(`${path}/`)) {
        return true;
      }
    }
    return false;
  }
}
