'use strict';

(function (scope) {
  const WINDOW_MS = 1000;
  const BUCKETS = 2;
  const CONFIGURED_ENCODER_LIMITS = 'Configured encoder limits (not measurements): max 1280 px, up to 60 fps, 6 Mbps H.264.';

  function defaultNow() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0;
  }

  function createStreamStats(options) {
    const now = options && typeof options.now === 'function' ? options.now : defaultNow;
    let windowStart = 0;
    let bytes = 0;
    let frames = 0;
    let lastBytes = null;
    let lastFrames = null;
    let started = false;
    let generation = 0;
    const view = {
      mediaBytesPerSecond: null,
      decodedFramesDrawnPerSecond: null,
      complete: false,
      generation: 0,
    };

    function reset() {
      windowStart = 0;
      bytes = 0;
      frames = 0;
      lastBytes = null;
      lastFrames = null;
      started = false;
      generation += 1;
    }

    function rotate(time) {
      if (!started) {
        windowStart = time;
        started = true;
        return;
      }
      if (time < windowStart) {
        reset();
        windowStart = time;
        started = true;
        return;
      }
      let elapsed = time - windowStart;
      if (elapsed < WINDOW_MS) return;
      if (elapsed >= WINDOW_MS * 2) {
        lastBytes = 0;
        lastFrames = 0;
        windowStart += Math.floor(elapsed / WINDOW_MS) * WINDOW_MS;
        bytes = 0;
        frames = 0;
        return;
      }
      lastBytes = bytes;
      lastFrames = frames;
      windowStart += WINDOW_MS;
      bytes = 0;
      frames = 0;
    }

    function recordMediaBytes(count, time) {
      if (!(count > 0)) return;
      const at = time === undefined ? now() : time;
      rotate(at);
      bytes += count;
    }

    function recordDrawnFrame(time) {
      const at = time === undefined ? now() : time;
      rotate(at);
      frames += 1;
    }

    function snapshot(time) {
      const at = time === undefined ? now() : time;
      if (started) rotate(at);
      const complete = lastBytes !== null;
      view.mediaBytesPerSecond = lastBytes;
      view.decodedFramesDrawnPerSecond = lastFrames;
      view.complete = complete;
      view.generation = generation;
      return view;
    }

    function capacity() {
      return { buckets: BUCKETS, bytes: 1, frames: 1 };
    }

    return {
      recordMediaBytes,
      recordDrawnFrame,
      snapshot,
      reset,
      capacity,
      get generation() { return generation; },
    };
  }

  function formatCount(value, unit) {
    if (value === null || value === undefined) return '—';
    return `${Math.round(value)} ${unit}`;
  }

  function formatSnapshot(snap, queueLength, status) {
    const unavailable = status === 'unavailable' || !snap;
    const waiting = unavailable || !snap.complete;
    const placeholder = unavailable ? '—' : 'Collecting';
    return {
      bytes: waiting ? placeholder : formatCount(snap.mediaBytesPerSecond, 'B / s'),
      frames: waiting ? placeholder : formatCount(snap.decodedFramesDrawnPerSecond, 'frames / s'),
      queue: queueLength === null || queueLength === undefined ? '—' : String(queueLength),
    };
  }

  scope.DroidDockStreamStats = {
    WINDOW_MS,
    BUCKETS,
    CONFIGURED_ENCODER_LIMITS,
    createStreamStats,
    formatSnapshot,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
