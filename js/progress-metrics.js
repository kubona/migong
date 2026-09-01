const PHASE_INDEX = Object.freeze({ test: 0, review: 1, optimize: 2 });
const PHASE_COUNT = 3;

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function progressWithinMonster(progress = {}) {
  const phaseIndex = PHASE_INDEX[progress.phase];
  if (phaseIndex == null) return 0;
  const completed = Math.max(0, finite(progress.phaseCompletedBatches, 0));
  const total = Math.max(0, finite(progress.phaseTotalBatches, 0));
  const phaseFraction = progress.phaseComplete ? 1 : total > 0 ? Math.min(1, completed / total) : 0;
  const directionCount = Math.max(1, Math.floor(finite(progress.directionCount, 1)));
  const directionIndex = Math.min(directionCount, Math.max(1, Math.floor(finite(progress.directionIndex, 1))));
  const directionFraction = (phaseIndex + phaseFraction) / PHASE_COUNT;
  return Math.min(1, ((directionIndex - 1) + directionFraction) / directionCount);
}

export function formatRunDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(finite(milliseconds, 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}时${String(minutes).padStart(2, "0")}分${String(seconds).padStart(2, "0")}秒`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

export function remainingMilliseconds(activeElapsedMilliseconds, progressFraction) {
  const elapsed = Math.max(0, finite(activeElapsedMilliseconds, 0));
  const progress = finite(progressFraction, 0);
  if (elapsed <= 0 || progress <= 0 || progress >= 1) return progress >= 1 ? 0 : null;
  return Math.max(0, elapsed * (1 - progress) / progress);
}

export function maximumBinaryProbeCount(minimumLevel, maximumLevel) {
  const minimum = Math.floor(finite(minimumLevel, 1));
  const maximum = Math.max(minimum, Math.floor(finite(maximumLevel, minimum)));
  return Math.max(1, Math.ceil(Math.log2(maximum - minimum + 2)));
}
