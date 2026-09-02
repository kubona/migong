function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ordinal(value) {
  return Math.max(0, Math.floor(finite(value, 0)));
}

export function createBoundedResultRetention(options = {}) {
  const compare = typeof options.compare === "function" ? options.compare : () => 0;
  const toleranceRatio = Math.max(0, Math.min(0.5, finite(options.toleranceRatio, 0.01)));
  let bestLevel = 0;
  let reviewFloor = 0;
  let fallback = null;
  let retained = [];
  let totalResults = 0;
  let totalProbes = 0;

  return {
    consider(entry, sourceOrdinal = totalResults) {
      totalResults += 1;
      totalProbes += Math.max(0, Math.floor(finite(entry?.probeCount, 0)));
      const wrapped = { entry, ordinal: ordinal(sourceOrdinal) };
      if (!entry?.targetMet) {
        if (bestLevel === 0 && (!fallback || compare(entry, fallback.entry) < 0
          || (compare(entry, fallback.entry) === 0 && wrapped.ordinal < fallback.ordinal))) fallback = wrapped;
        return;
      }

      const level = Math.max(0, Math.floor(finite(entry.highestLevel, 0)));
      if (level > bestLevel) {
        bestLevel = level;
        reviewFloor = Math.ceil(bestLevel * (1 - toleranceRatio));
        retained = retained.filter((candidate) => finite(candidate.entry?.highestLevel, 0) >= reviewFloor);
        fallback = null;
      }
      if (level >= reviewFloor) retained.push(wrapped);
    },
    finish() {
      const selected = retained.length ? retained : fallback ? [fallback] : [];
      selected.sort((left, right) => left.ordinal - right.ordinal);
      return {
        bestLevel,
        reviewFloor,
        candidates: selected.map((candidate) => candidate.entry),
        totalResults,
        totalProbes,
      };
    },
  };
}

export function createTopResultRetention(options = {}) {
  const compare = typeof options.compare === "function" ? options.compare : () => 0;
  const limit = Math.max(1, Math.floor(finite(options.limit, 1)));
  let retained = [];

  return {
    consider(entry, sourceOrdinal = 0) {
      retained.push({ entry, ordinal: ordinal(sourceOrdinal) });
      retained.sort((left, right) => compare(left.entry, right.entry) || left.ordinal - right.ordinal);
      if (retained.length > limit) retained.length = limit;
    },
    finish() {
      return retained.map((candidate) => candidate.entry);
    },
  };
}
