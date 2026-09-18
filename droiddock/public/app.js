'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('screen');
  const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const keyButtons = [...document.querySelectorAll('[data-key]')];
  let socket = null;
  let decoder = null;
  let decoderConfiguration = null;
  let codecBytes = null;
  let waitingForKey = true;
  let pendingMedia = [];
  let supportProbe = null;
  let state = 'idle';
  let hasFrame = false;
  let pointer = null;
  let pendingMove = null;
  let moveAnimation = 0;
  let connectionTimer = 0;
  let generation = 0;
  const available = typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
  const MAX_DECODE_QUEUE = 8;

  function canControl() {
    return state === 'connected' && hasFrame && socket?.readyState === WebSocket.OPEN;
  }

  function setState(next, message = '') {
    state = next;
    const labels = { idle: 'Disconnected', connecting: 'Connecting', connected: 'Connected', moved: 'Opened elsewhere', error: 'Connection error' };
    $('state').textContent = labels[next] || next;
    $('state').dataset.state = next;
    const connectionLabel = next === 'connecting' || next === 'connected' ? 'Disconnect' : 'Connect';
    $('connect-label').textContent = connectionLabel;
    $('connect').title = connectionLabel;
    $('connect').setAttribute('aria-label', connectionLabel);
    $('connect').dataset.connected = String(next === 'connecting' || next === 'connected');
    $('state').title = labels[next] || next;
    $('message').textContent = message || (next === 'connected' ? 'Focus a phone text field, then type or press Ctrl+V to paste. Tab stays in the browser. Fallback text input is available here for apps that block paste.' : 'Phone must be connected through ADB.');
    $('message').classList.toggle('error', next === 'error');
    updateControls();
    if (!hasFrame) {
      $('empty-title').textContent = next === 'connecting' || next === 'connected' ? 'Connecting to your phone…' : next === 'moved' ? 'Phone opened elsewhere.' : next === 'error' ? 'The phone is unavailable.' : 'Your phone, within reach.';
      $('empty-message').textContent = message || (next === 'connecting' || next === 'connected' ? 'Waiting for the live screen.' : 'Connect to see and control your Android phone here.');
    }
  }

  function updateControls() {
    const disabled = !canControl();
    keyButtons.forEach((button) => { button.disabled = disabled; });
    $('text-input').disabled = disabled;
    $('send-text').disabled = disabled;
  }

  function fitScreen() {
    if (!hasFrame) return;
    const bounds = $('screen-area').getBoundingClientRect();
    const scale = Math.min(bounds.width / canvas.width, bounds.height / canvas.height);
    canvas.style.width = `${Math.max(1, Math.floor(canvas.width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(canvas.height * scale))}px`;
  }

  function resetDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = null;
    decoderConfiguration = null;
    codecBytes = null;
    waitingForKey = true;
    pendingMedia = [];
    supportProbe = null;
  }

  function isCurrentProbe(probe, streamGeneration) {
    return Boolean(probe && supportProbe === probe && streamGeneration === generation && socket);
  }

  function supportCheckError(detail) {
    return detail
      ? `Could not check H.264 decoder support: ${detail}. Open DroidDock in a current Chrome or Edge browser on localhost.`
      : 'Could not check H.264 decoder support. Open DroidDock in a current Chrome or Edge browser on localhost.';
  }

  function unsupportedConfigError(codec) {
    return `This browser cannot decode the phone's H.264 video (${codec}). Open DroidDock in a current Chrome or Edge browser on localhost.`;
  }

  function clearScreen() {
    releasePointer();
    resetDecoder();
    hasFrame = false;
    canvas.hidden = true;
    $('empty').hidden = false;
    $('resolution').textContent = '';
    context.clearRect(0, 0, canvas.width, canvas.height);
    updateControls();
  }

  function fail(message) {
    clearTimeout(connectionTimer);
    const oldSocket = socket;
    socket = null;
    oldSocket?.close();
    clearScreen();
    setState('error', message);
  }

  function send(payload) {
    if (!canControl()) return false;
    // Avoid queuing stale gestures on a stalled connection.
    if (socket.bufferedAmount > 256 * 1024) {
      fail('The connection is too slow to send controls. Connect again.');
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  async function connect() {
    if (!available) {
      fail('Live video needs WebCodecs. Open DroidDock in a current Chrome or Edge browser on localhost.');
      return;
    }
    const currentGeneration = ++generation;
    clearScreen();
    setState('connecting');
    $('device').textContent = 'Connecting to phone';
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?takeover=1`);
    socket = ws;
    ws.binaryType = 'arraybuffer';
    connectionTimer = setTimeout(() => {
      if (socket === ws && !hasFrame) fail('No video arrived. Check that your phone is connected and unlocked, then connect again.');
    }, 30000);
    ws.onopen = () => {
      if (socket === ws && currentGeneration === generation) ws.send(JSON.stringify({ type: 'connect' }));
      else ws.close();
    };
    ws.onmessage = (event) => {
      if (socket !== ws || currentGeneration !== generation) return;
      try {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'moved') {
            clearTimeout(connectionTimer);
            ++generation;
            socket = null;
            ws.close();
            clearScreen();
            setState('moved', 'Select Connect to bring your phone back here.');
            return;
          } else if (message.type === 'status') {
            if (message.device) $('device').textContent = typeof message.device === 'string' ? message.device : message.device.name || message.device.model || message.device.serial || 'Android phone';
            // The greeting describes the previous attempt, including a retained
            // cleanup error. Wait for this socket's connect result before failing.
            if (message.snapshot === true) return;
            if (message.state === 'error') { fail(message.message || 'The phone connection failed. Check ADB and connect again.'); return; }
            if (message.state === 'idle') {
              // A newly attached socket receives the pre-connect server snapshot.
              if (state === 'connecting' && !hasFrame) return;
              fail(message.message || 'The phone disconnected. Check its connection and connect again.');
              return;
            }
            if (message.state === 'connected' || message.state === 'connecting') setState(message.state, message.message);
          } else if (message.type === 'inputError') {
            $('message').textContent = message.message || 'The phone could not receive that input. Try again.';
            $('message').classList.add('error');
          } else if (message.type === 'video') {
            // scrcpy starts a new codec session after rotation or encoder changes.
            clearScreen();
            setState(state, 'Waiting for the live screen.');
          }
        } else if (event.data instanceof ArrayBuffer) {
          decodePacket(event.data, currentGeneration);
        }
      } catch (error) { fail(`Could not read the phone stream: ${error.message}`); }
    };
    ws.onerror = () => { if (socket === ws) fail('Cannot reach DroidDock. Check that the local server is running, then connect again.'); };
    ws.onclose = () => { if (socket === ws) fail('The phone connection closed. Check ADB and connect again.'); };
  }

  async function disconnect() {
    releasePointer();
    ++generation;
    clearTimeout(connectionTimer);
    const oldSocket = socket;
    socket = null;
    oldSocket?.close();
    clearScreen();
    $('device').textContent = 'Phone disconnected';
    setState('idle');
    // Closing this socket releases only its own session. An old view never
    // sends a global HTTP disconnect that could affect a replacement view.
  }

  function codecFromAnnexB(bytes) {
    for (let i = 0; i + 6 < bytes.length; i++) {
      if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
      const prefix = bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0;
      const nal = i + prefix;
      if (prefix && (bytes[nal] & 31) === 7 && nal + 3 < bytes.length) {
        return `avc1.${[bytes[nal + 1], bytes[nal + 2], bytes[nal + 3]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      }
    }
    throw new Error('The phone did not provide an H.264 video configuration.');
  }

  function prepareMedia(keyframe, data) {
    if (waitingForKey && !keyframe) return null;
    if (keyframe) {
      const combined = new Uint8Array(codecBytes.length + data.length);
      combined.set(codecBytes);
      combined.set(data, codecBytes.length);
      waitingForKey = false;
      return combined;
    }
    return data.slice();
  }

  function decodeMedia(flags, keyframe, data, prepared) {
    if (!decoder || !codecBytes) return;
    if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // Dropping interdependent frames can freeze the display until another IDR.
      fail('Video decoding fell behind. Connect again to restart the live screen.');
      return;
    }
    const payload = prepared ? data : prepareMedia(keyframe, data);
    if (!payload) return;
    decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp: Number(flags & ((1n << 62n) - 1n)), data: payload }));
  }

  function enqueuePendingMedia(flags, keyframe, data) {
    const payload = prepareMedia(keyframe, data);
    if (!payload) return;
    if (pendingMedia.length >= MAX_DECODE_QUEUE) {
      fail('Video decoding fell behind. Connect again to restart the live screen.');
      return;
    }
    pendingMedia.push({ flags, keyframe, data: payload });
  }

  function attachDecoder(probe, streamGeneration) {
    if (!isCurrentProbe(probe, streamGeneration)) return;
    try {
      const configuration = probe.configuration;
      const activeDecoder = new VideoDecoder({
        output(frame) {
          try {
            if (streamGeneration !== generation || decoder !== activeDecoder || !socket) return;
            const changed = canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight;
            if (changed) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; }
            context.drawImage(frame, 0, 0, canvas.width, canvas.height);
            const firstFrame = !hasFrame;
            if (firstFrame || changed) {
              hasFrame = true;
              canvas.hidden = false;
              $('empty').hidden = true;
              $('resolution').textContent = `${canvas.width} × ${canvas.height}`;
              fitScreen();
            }
            clearTimeout(connectionTimer);
            if (firstFrame || state !== 'connected') setState('connected');
            else updateControls();
          } finally { frame.close(); }
        },
        error(error) {
          if (decoder === activeDecoder && streamGeneration === generation) fail(`Video decoding stopped: ${error.message}. Connect again to retry.`);
        },
      });
      decoder = activeDecoder;
      activeDecoder.configure(configuration);
      if (decoder !== activeDecoder || streamGeneration !== generation || !socket) return;
      const queued = pendingMedia;
      pendingMedia = [];
      supportProbe = null;
      for (const packet of queued) {
        if (decoder !== activeDecoder || streamGeneration !== generation || !socket) return;
        decodeMedia(packet.flags, packet.keyframe, packet.data, true);
      }
    } catch (error) {
      if (streamGeneration === generation && socket) fail(`Video decoding stopped: ${error.message}. Connect again to retry.`);
    }
  }

  function startSupportProbe(streamGeneration) {
    const configuration = decoderConfiguration;
    const probe = { configuration };
    supportProbe = probe;
    if (typeof VideoDecoder.isConfigSupported !== 'function') {
      fail(supportCheckError());
      return;
    }
    // Always settle on a later turn so stale disconnect/rotation work cannot race a sync result.
    Promise.resolve()
      .then(() => VideoDecoder.isConfigSupported({ ...configuration }))
      .then((result) => {
        if (!isCurrentProbe(probe, streamGeneration)) return;
        if (!result || result.supported !== true) {
          fail(unsupportedConfigError(configuration.codec));
          return;
        }
        attachDecoder(probe, streamGeneration);
      })
      .catch((error) => {
        if (!isCurrentProbe(probe, streamGeneration)) return;
        fail(supportCheckError(error && error.message ? String(error.message) : ''));
      });
  }

  function decodePacket(buffer, streamGeneration) {
    if (buffer.byteLength < 12) throw new Error('Incomplete video packet.');
    const header = new DataView(buffer);
    const flags = header.getBigUint64(0, false);
    const size = header.getUint32(8, false);
    if (size !== buffer.byteLength - 12 || size > 16 * 1024 * 1024) throw new Error('Invalid video packet size.');
    const config = (flags & (1n << 63n)) !== 0n;
    const keyframe = (flags & (1n << 62n)) !== 0n;
    const data = new Uint8Array(buffer, 12);
    if (config) {
      if (size > 1024 * 1024) throw new Error('Invalid video configuration size.');
      resetDecoder();
      codecBytes = data.slice();
      decoderConfiguration = { codec: codecFromAnnexB(data), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };
      startSupportProbe(streamGeneration);
      return;
    }
    if (supportProbe && !decoder) {
      enqueuePendingMedia(flags, keyframe, data);
      return;
    }
    if (!decoder || !codecBytes) return;
    decodeMedia(flags, keyframe, data, false);
  }

  function coordinates(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width - 1, Math.floor((event.clientX - rect.left) * canvas.width / rect.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.floor((event.clientY - rect.top) * canvas.height / rect.height))), width: canvas.width, height: canvas.height };
  }

  function flushMove() {
    cancelAnimationFrame(moveAnimation);
    moveAnimation = 0;
    const move = pendingMove;
    pendingMove = null;
    if (move && pointer !== null) send({ type: 'touch', action: 2, ...move });
  }

  function releasePointer(event) {
    if (pointer === null || (event && event.pointerId !== pointer.id)) return;
    const active = pointer;
    flushMove();
    if (pointer !== active) return;
    pointer = null;
    send({ type: 'touch', action: 1, ...(event ? coordinates(event) : active.last) });
    if (canvas.hasPointerCapture(active.id)) canvas.releasePointerCapture(active.id);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!canControl() || pointer !== null || event.button !== 0) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    pointer = { id: event.pointerId, last: coordinates(event) };
    canvas.setPointerCapture(event.pointerId);
    send({ type: 'touch', action: 0, ...pointer.last });
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    pointer.last = coordinates(event);
    pendingMove = pointer.last;
    if (!moveAnimation) moveAnimation = requestAnimationFrame(flushMove);
  });
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('lostpointercapture', releasePointer);
  window.addEventListener('blur', () => releasePointer());
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    if (!canControl()) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    send({ type: 'scroll', ...coordinates(event), dx: Math.max(-1, Math.min(1, -event.deltaX * unit / 100)), dy: Math.max(-1, Math.min(1, -event.deltaY * unit / 100)) });
  }, { passive: false });
  const keyboardKeys = { Escape: 'back', Home: 'home', Enter: 'enter', Backspace: 'backspace', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  canvas.addEventListener('paste', (event) => {
    // Read only the text supplied by the user's paste gesture, never poll or
    // request background access to the system clipboard.
    event.preventDefault();
    if (!canControl()) return;
    const text = event.clipboardData?.getData('text/plain');
    if (!text) {
      $('message').textContent = 'Copy some text first. Image and file pastes are not supported.';
      $('message').classList.add('error');
      return;
    }
    if (new TextEncoder().encode(text).length > 65536) {
      $('message').textContent = 'That paste is too large. Paste up to 64 KiB of text at a time.';
      $('message').classList.add('error');
      return;
    }
    if (send({ type: 'paste', text })) {
      $('message').textContent = 'Paste sent to the phone’s focused field.';
      $('message').classList.remove('error');
    }
  });
  function closeMoreControls() {
    const panel = $('more-controls');
    if (!panel.open) return false;
    panel.open = false;
    panel.querySelector('summary').focus();
    return true;
  }
  canvas.addEventListener('keydown', (event) => {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    // Keep normal Tab navigation available; use text entry for tab characters.
    if (event.key === 'Tab') return;
    // Dismiss the details overlay first so Escape does not send Android Back
    // while the panel is covering the screen.
    if (event.key === 'Escape' && closeMoreControls()) {
      event.preventDefault();
      return;
    }
    if (!canControl()) return;
    const key = keyboardKeys[event.key];
    if (key) { event.preventDefault(); send({ type: 'key', key }); }
    else if (event.key.length === 1) { event.preventDefault(); send({ type: 'text', text: event.key }); }
  });
  keyButtons.forEach((button) => button.addEventListener('click', () => send({ type: 'key', key: button.dataset.key })));
  $('text-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('text-input');
    if (new TextEncoder().encode(input.value).length > 300) {
      $('message').textContent = 'That text is too long. Send up to 300 UTF-8 bytes at a time (300 plain English characters).';
      $('message').classList.add('error');
      input.focus();
      return;
    }
    if (input.value && send({ type: 'text', text: input.value })) input.value = '';
  });
  $('connect').addEventListener('click', () => { if (socket) disconnect(); else connect(); });
  document.addEventListener('pointerdown', (event) => {
    if (!$('more-controls').contains(event.target)) $('more-controls').open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (closeMoreControls()) event.preventDefault();
  });
  new MutationObserver(() => {
    const summary = $('more-controls').querySelector('summary');
    summary.title = $('message').textContent;
    if ($('message').classList.contains('error') && hasFrame) $('more-controls').open = true;
  }).observe($('message'), { childList: true, attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(fitScreen).observe($('screen-area'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) releasePointer(); });
  fetch('/api/status').then((response) => {
    if (!response.ok) throw new Error();
    return response.json();
  }).then((status) => {
    if (socket || generation !== 0) return;
    if (!available) setState('error', 'Live video needs WebCodecs. Open DroidDock in a current Chrome or Edge browser on localhost.');
    else if (status.state === 'error') setState('error', status.message || 'Check that your phone is connected through ADB, then connect.');
    else setState('idle', status.state === 'connected' || status.state === 'connecting' ? 'A phone session is available. Connect to open its screen.' : 'Phone must be connected through ADB.');
  }).catch(() => { if (!socket && generation === 0) setState('error', 'Cannot reach DroidDock. Check that the local server is running.'); });
})();
