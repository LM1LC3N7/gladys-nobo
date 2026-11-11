// -----------------------------------------------------------------------------
// Fake timers on a virtual clock: nothing fires by itself; `advance(ms)` moves
// the clock and runs every timer due on the way, in order, letting the
// promises settle after each (a timer is never awaited, as in Node).
// `sleep(ms)` is a promise resolved by such a timer (a slow controller).
// -----------------------------------------------------------------------------

/** Lets the pending promises settle (no timer involved). */
const drain = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export function createFakeClock(start) {
  const clock = { now: start };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      const every = Math.max(1, Number(ms) || 0);
      const run = () => {
        const timer = pending.get(id);
        if (!timer) return undefined;
        timer.at += every;
        return fn();
      };
      pending.set(id, { fn: run, at: clock.now + every, interval: true });
      return id;
    },
    clearInterval(id) {
      pending.delete(id);
    },
  };
  async function advance(ms) {
    const target = clock.now + ms;
    for (let i = 0; i < 100_000; i += 1) {
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) {
          next = { id, timer };
        }
      }
      if (!next) {
        break;
      }
      if (!next.timer.interval) {
        pending.delete(next.id);
      }
      clock.now = Math.max(clock.now, next.timer.at);
      // Fired as a real timer is: never awaited (a timer waiting for another
      // timer would block the clock), then the promises settle.
      Promise.resolve()
        .then(() => next.timer.fn())
        .catch(() => {});
      await drain();
    }
    // Never back: a slow answer may have moved the clock beyond the target.
    clock.now = Math.max(clock.now, target);
  }
  clock.sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));
  return { clock, timers, pending, advance };
}
