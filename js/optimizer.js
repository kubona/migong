// Stable application-facing seam. The exhaustive workflow owns candidate
// generation, stage transitions, deduplication, and level-search execution.
import { optimizeMonsterExhaustive } from './exhaustive-optimizer.js';
import { optimizeMonsterLearning } from './learning-optimizer.js';
export { searchHighestLevelForPlan } from './exhaustive-optimizer.js';
export function optimizeMonster(options) {
  return options.searchMode === 'learning' ? optimizeMonsterLearning(options) : optimizeMonsterExhaustive(options);
}
