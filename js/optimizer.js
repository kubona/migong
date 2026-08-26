// Stable application-facing seam. The exhaustive workflow owns candidate
// generation, stage transitions, deduplication, and level-search execution.
export {
  optimizeMonsterExhaustive as optimizeMonster,
  searchHighestLevelForPlan,
} from "./exhaustive-optimizer.js";
