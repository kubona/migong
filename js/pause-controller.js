function abortError() {
  return new DOMException("模拟已取消", "AbortError");
}

export function createPauseController() {
  let paused = false;
  const waiters = new Set();

  return {
    get paused() { return paused; },
    pause() { paused = true; },
    resume() {
      if (!paused) return;
      paused = false;
      for (const resumeWaiter of [...waiters]) resumeWaiter();
    },
    async waitIfPaused(signal) {
      if (signal?.aborted) throw abortError();
      if (!paused) return;
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          waiters.delete(release);
          signal?.removeEventListener("abort", cancel);
        };
        const release = () => {
          cleanup();
          resolve();
        };
        const cancel = () => {
          cleanup();
          reject(abortError());
        };
        waiters.add(release);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  };
}
