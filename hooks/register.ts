// The engine takes one hooks module per plugin, so this is the entry point
// that registers both features.

import { register as registerCompaction } from './compaction.ts';
import { register as registerTrim } from './trim-results.ts';

export const register = (on, options) => {
  registerCompaction(on, options);
  registerTrim(on, options);
};
