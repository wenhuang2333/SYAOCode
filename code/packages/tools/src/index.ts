import type { Tool } from '@syaocode/core';
import { FileStateTracker } from './file-state.js';
import { createReadTool, createWriteTool, createEditTool } from './fs-tools.js';
import { createGlobTool, createGrepTool } from './search-tools.js';
import { createBashTool } from './bash.js';

export { FileStateTracker } from './file-state.js';
export type { FileState } from './file-state.js';
export { createReadTool, createWriteTool, createEditTool } from './fs-tools.js';
export { createGlobTool, createGrepTool, loadGitignore, isIgnored } from './search-tools.js';
export type { IgnoreRules } from './search-tools.js';
export { createBashTool } from './bash.js';

export interface BuiltinToolsOptions {
  bash?: { defaultTimeoutMs?: number };
}

/** All six P0 built-in tools sharing one FileStateTracker. */
export function createBuiltinTools(opts: BuiltinToolsOptions = {}): { tools: Tool[]; fileState: FileStateTracker } {
  const fileState = new FileStateTracker();
  const tools: Tool[] = [
    createReadTool(fileState),
    createWriteTool(fileState),
    createEditTool(fileState),
    createGlobTool(),
    createGrepTool(),
    createBashTool(opts.bash),
  ];
  return { tools, fileState };
}
