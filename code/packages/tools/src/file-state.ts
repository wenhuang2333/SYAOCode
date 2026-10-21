import { FsError, contentHash } from '@syaocode/core';

/**
 * FileStateTracker (DD-4): supports read-before-write (BR-004) and external-
 * modification detection. Records {hash, mtimeMs} at read time; write tools
 * must verify before mutating.
 */
export interface FileState {
  hash: string;
  mtimeMs: number;
}

export class FileStateTracker {
  private states = new Map<string, FileState>();

  recordRead(path: string, content: string, mtimeMs: number): void {
    this.states.set(path, { hash: contentHash(content), mtimeMs });
  }

  hasRead(path: string): boolean {
    return this.states.has(path);
  }

  /** Throws SY-FS-001 when never read, SY-FS-002 when changed since read. */
  assertUnchanged(path: string, currentContent: string, currentMtimeMs: number): void {
    const state = this.states.get(path);
    if (state === undefined) {
      throw new FsError({
        code: 'SY-FS-001',
        modelMessage: `File ${path} has not been read in this session yet. Use the read tool on it before modifying (BR-004).`,
      });
    }
    if (state.mtimeMs !== currentMtimeMs || state.hash !== contentHash(currentContent)) {
      throw new FsError({
        code: 'SY-FS-002',
        modelMessage: `File ${path} changed on disk since it was last read. Read it again, then retry the edit.`,
      });
    }
  }

  recordWrite(path: string, content: string, mtimeMs: number): void {
    this.states.set(path, { hash: contentHash(content), mtimeMs });
  }
}
