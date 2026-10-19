(() => {
  const query = new URLSearchParams(location.search);
  const pin = query.get('pin') || sessionStorage.getItem('pocket-pointer-pin') || '';
  if (query.get('pin')) sessionStorage.setItem('pocket-pointer-pin', pin);

  const status = document.querySelector('#remote-status');
  const statusText = document.querySelector('#remote-status-text');
  const alertBox = document.querySelector('#remote-alert');
  const pauseButton = document.querySelector('#remote-pause');
  const trackpad = document.querySelector('#trackpad');
  const settingsBackdrop = document.querySelector('#settings-backdrop');
  const keyboardTools = document.querySelector('#keyboard-tools');
  const keyboardToolsToggle = document.querySelector('#keyboard-tools-toggle');
  const keyboardLayoutToggle = document.querySelector('#keyboard-layout-toggle');
  const keyboardLayoutToggleSymbols = document.querySelector('#keyboard-layout-toggle-symbols');
  const lettersLayout = document.querySelector('#letters-layout');
  const symbolsLayout = document.querySelector('#symbols-layout');
  const typedPreview = document.querySelector('#typed-preview');
  const typedPreviewBefore = document.querySelector('#typed-preview-before');
  const typedPreviewAfter = document.querySelector('#typed-preview-after');
  const keyboardFeedback = document.querySelector('#keyboard-feedback');
  const clearPreviewButton = document.querySelector('#clear-preview');
  const sensitivityInput = document.querySelector('#mouse-sensitivity');
  const sensitivityReadout = document.querySelector('#mouse-sensitivity-value');
  const fields = [...document.querySelectorAll('[data-setting]')];
  const tabs = [...document.querySelectorAll('[data-view]')];
  const views = [...document.querySelectorAll('.controller-view')];

  document.addEventListener('selectstart', (event) => event.preventDefault());
  document.addEventListener('dragstart', (event) => event.preventDefault());

  let socket;
  let retryTimer;
  let settings = { enabled: true, mouse: true, keyboard: true, scroll: true, click: true, tapClick: true };
  let mode = 'mouse-view';
  let capsLocked = false;
  const keyboardQueue = [];
  let keyboardFlushScheduled = false;
  let mouseSensitivity = 1.7;
  const pointers = new Map();
  const modifiers = new Set();
  let lastScrollY = null;
  let pendingDx = 0;
  let pendingDy = 0;
  let mouseRemainderX = 0;
  let mouseRemainderY = 0;
  let pendingWheel = 0;
  let flushScheduled = false;
  let typedPreviewValue = '';
  let typedPreviewCursor = 0;
  const keyPulseTimers = new WeakMap();
  const graphemeSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

  try {
    const savedSensitivity = Number(localStorage.getItem('pocket-pointer-mouse-sensitivity'));
    if (Number.isFinite(savedSensitivity) && savedSensitivity >= 0.5 && savedSensitivity <= 3) mouseSensitivity = savedSensitivity;
  } catch {}

  function updateSensitivity(value) {
    mouseSensitivity = Math.max(0.5, Math.min(3, Number(value) / 100));
    sensitivityInput.value = String(Math.round(mouseSensitivity * 100));
    sensitivityReadout.textContent = `${mouseSensitivity.toFixed(1)}×`;
    try { localStorage.setItem('pocket-pointer-mouse-sensitivity', String(mouseSensitivity)); } catch {}
  }
  updateSensitivity(mouseSensitivity * 100);
  sensitivityInput.addEventListener('input', () => updateSensitivity(sensitivityInput.value));

  function splitCharacters(value) {
    if (graphemeSegmenter) return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
    return Array.from(value);
  }

  function updateTypedPreview() {
    const characters = splitCharacters(typedPreviewValue);
    typedPreviewCursor = Math.max(0, Math.min(characters.length, typedPreviewCursor));
    const context = 18;
    const start = Math.max(0, typedPreviewCursor - context);
    const end = Math.min(characters.length, typedPreviewCursor + context);
    typedPreviewBefore.textContent = (start > 0 ? '…' : '') + characters.slice(start, typedPreviewCursor).join('');
    typedPreviewAfter.textContent = characters.slice(typedPreviewCursor, end).join('') + (end < characters.length ? '…' : '');
    typedPreview.classList.toggle('is-empty', typedPreviewValue.length === 0);
    typedPreview.scrollTop = typedPreview.scrollHeight;
  }

  function clearTypedPreview() {
    typedPreviewValue = '';
    typedPreviewCursor = 0;
    updateTypedPreview();
    keyboardFeedback.textContent = 'Ready';
  }

  function addPreviewText(value) {
    if (!value) return;
    const characters = splitCharacters(typedPreviewValue);
    const inserted = splitCharacters(value);
    characters.splice(typedPreviewCursor, 0, ...inserted);
    typedPreviewCursor += inserted.length;
    if (characters.length > 1200) {
      const trimCount = characters.length - 1200;
      characters.splice(0, trimCount);
      typedPreviewCursor = Math.max(0, typedPreviewCursor - trimCount);
    }
    typedPreviewValue = characters.join('');
    updateTypedPreview();
  }

  function removePreviewCharacter() {
    const characters = splitCharacters(typedPreviewValue);
    if (typedPreviewCursor > 0) {
      characters.splice(typedPreviewCursor - 1, 1);
      typedPreviewCursor--;
    }
    typedPreviewValue = characters.join('');
    updateTypedPreview();
  }

  function removePreviewNextCharacter() {
    const characters = splitCharacters(typedPreviewValue);
    if (typedPreviewCursor < characters.length) characters.splice(typedPreviewCursor, 1);
    typedPreviewValue = characters.join('');
    updateTypedPreview();
  }

  function removePreviewWord(backward) {
    const characters = splitCharacters(typedPreviewValue);
    let end = typedPreviewCursor;
    let start = end;
    if (backward) {
      while (start > 0 && /^\s$/u.test(characters[start - 1])) start--;
      while (start > 0 && !/^\s$/u.test(characters[start - 1])) start--;
    } else {
      while (end < characters.length && /^\s$/u.test(characters[end])) end++;
      while (end < characters.length && !/^\s$/u.test(characters[end])) end++;
    }
    characters.splice(start, end - start);
    if (backward) typedPreviewCursor = start;
    typedPreviewValue = characters.join('');
    updateTypedPreview();
  }

  function movePreviewCursor(direction, byWord = false) {
    const characters = splitCharacters(typedPreviewValue);
    if (byWord && direction < 0) {
      while (typedPreviewCursor > 0 && /^\s$/u.test(characters[typedPreviewCursor - 1])) typedPreviewCursor--;
      while (typedPreviewCursor > 0 && !/^\s$/u.test(characters[typedPreviewCursor - 1])) typedPreviewCursor--;
    } else if (byWord) {
      while (typedPreviewCursor < characters.length && !/^\s$/u.test(characters[typedPreviewCursor])) typedPreviewCursor++;
      while (typedPreviewCursor < characters.length && /^\s$/u.test(characters[typedPreviewCursor])) typedPreviewCursor++;
    } else {
      typedPreviewCursor = Math.max(0, Math.min(characters.length, typedPreviewCursor + direction));
    }
    updateTypedPreview();
  }

  function flashKey(button, label) {
    button.classList.add('is-pressed');
    clearTimeout(keyPulseTimers.get(button));
    keyPulseTimers.set(button, setTimeout(() => button.classList.remove('is-pressed'), 110));
    keyboardFeedback.textContent = label;
  }

  clearPreviewButton.addEventListener('click', () => {
    clearTypedPreview();
    keyboardFeedback.textContent = 'Cleared';
  });

  function updateConnection(hostConnected = false, label = 'PC offline', message = '') {
    const online = Boolean(hostConnected);
    if (status) {
      status.classList.toggle('is-online', online);
      status.classList.toggle('is-offline', !online);
    }
    if (statusText) statusText.textContent = online ? 'Connected' : label;
    alertBox.hidden = online || !message;
    if (message) alertBox.textContent = message;
    updateControls();
  }

  function setMode(nextMode, focusKeyboard = false) {
    if (nextMode === 'keyboard-view' && !settings.keyboard) return;
    if (nextMode === 'mouse-view' && !settings.mouse) return;
    mode = nextMode;
    tabs.forEach((tab) => {
      const active = tab.dataset.view === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    views.forEach((view) => { view.hidden = view.id !== mode; });
  }

  function updateControls() {
    fields.forEach((field) => { field.checked = Boolean(settings[field.dataset.setting]); });
    const canMouse = settings.enabled && settings.mouse;
    const canKeyboard = settings.enabled && settings.keyboard;
    trackpad.classList.toggle('is-disabled', !canMouse);
    document.querySelectorAll('[data-mouse-button]').forEach((button) => { button.disabled = !canMouse || !settings.click; });
    document.querySelectorAll('[data-key], [data-char], [data-modifier]').forEach((button) => { button.disabled = !canKeyboard; });
    [keyboardLayoutToggle, keyboardLayoutToggleSymbols].forEach((button) => { if (button) button.disabled = !canKeyboard; });
    if (!canKeyboard) keyboardQueue.length = 0;
    if (pauseButton) {
      pauseButton.classList.toggle('is-paused', !settings.enabled);
      pauseButton.setAttribute('aria-label', settings.enabled ? 'Pause remote access' : 'Resume remote access');
      pauseButton.title = settings.enabled ? 'Pause remote access' : 'Resume remote access';
      pauseButton.textContent = settings.enabled ? 'Pause' : 'Resume';
    }
    if (!settings.enabled || !settings.keyboard) {
      modifiers.clear();
      document.querySelectorAll('[data-modifier]').forEach((button) => {
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
      });
      refreshKeyLabels();
      if (mode === 'keyboard-view') setMode(settings.mouse ? 'mouse-view' : 'keyboard-view');
    }
  }

  function send(packet) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
  }

  function sendInput(packet) {
    if (!settings.enabled) return;
    if (['move', 'button', 'wheel'].includes(packet.action) && !settings.mouse) return;
    if (packet.action === 'button' && !settings.click) return;
    if (packet.action === 'wheel' && !settings.scroll) return;
    if (['key', 'text'].includes(packet.action) && !settings.keyboard) return;
    send({ type: 'input', ...packet });
  }

  function applySettings(next) {
    if (!next) return;
    settings = { ...settings, ...next };
    updateControls();
  }

  function connect() {
    if (!pin) {
      updateConnection(false, 'Missing link code', 'Open the saved phone link from the PC.');
      return;
    }
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const attempt = new WebSocket(scheme + '//' + location.host + '/ws');
    socket = attempt;
    let paired = false;
    const handshakeTimer = setTimeout(() => {
      if (socket !== attempt || paired) return;
      updateConnection(false, 'No response', 'The phone page opened, but its live connection did not answer. Check that both devices are on the same Wi-Fi.');
      attempt.close();
    }, 8000);
    attempt.addEventListener('open', () => {
      if (socket === attempt) attempt.send(JSON.stringify({ type: 'pair', pin, client: 'remote' }));
    });
    attempt.addEventListener('message', (event) => {
      if (socket !== attempt) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'paired' || message.type === 'status') {
        paired = true;
        clearTimeout(handshakeTimer);
        applySettings(message.settings);
        flushKeyboardQueue();
        if (message.hostConnected) {
          updateConnection(true);
        } else {
          updateConnection(false, 'PC offline', 'The phone is connected, but the PC input bridge is offline. Keep Pocket Pointer running on the PC.');
        }
      }
    });
    attempt.addEventListener('error', () => {
      if (socket === attempt) updateConnection(false, 'Connection error', 'Could not reach the live controls. Check that both devices are on the same Wi-Fi.');
    });
    attempt.addEventListener('close', (event) => {
      clearTimeout(handshakeTimer);
      if (socket !== attempt) return;
      modifiers.clear();
      document.querySelectorAll('[data-modifier]').forEach((button) => {
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
      });
      refreshKeyLabels();
      if (event.code === 1008) {
        updateConnection(false, 'Check link', event.reason || 'This pairing link is no longer valid. Open the saved phone link from the PC.');
        return;
      }
      updateConnection(false, 'Reconnecting…', 'Live connection lost. Reconnecting…');
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 1500);
    });
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => {
    setMode(tab.dataset.view, tab.dataset.view === 'keyboard-view');
  }));

  keyboardToolsToggle.addEventListener('click', () => {
    const expanded = keyboardToolsToggle.getAttribute('aria-expanded') === 'true';
    keyboardToolsToggle.setAttribute('aria-expanded', String(!expanded));
    keyboardToolsToggle.textContent = expanded ? 'More keys' : 'Hide keys';
    keyboardTools.hidden = expanded;
  });

  function showKeyboardLayout(showSymbols) {
    lettersLayout.hidden = showSymbols;
    symbolsLayout.hidden = !showSymbols;
    keyboardLayoutToggle.setAttribute('aria-label', showSymbols ? 'Switch to letters' : 'Switch to numbers and symbols');
  }
  keyboardLayoutToggle.addEventListener('click', () => {
    showKeyboardLayout(true);
    flashKey(keyboardLayoutToggle, 'Numbers and symbols');
  });
  keyboardLayoutToggleSymbols.addEventListener('click', () => {
    showKeyboardLayout(false);
    flashKey(keyboardLayoutToggleSymbols, 'Letters');
  });

  document.querySelector('#settings-open').addEventListener('click', () => {
    settingsBackdrop.hidden = false;
    document.querySelector('#settings-close').focus();
  });
  document.querySelector('#settings-close').addEventListener('click', () => { settingsBackdrop.hidden = true; });
  settingsBackdrop.addEventListener('click', (event) => { if (event.target === settingsBackdrop) settingsBackdrop.hidden = true; });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !settingsBackdrop.hidden) settingsBackdrop.hidden = true;
  });

  fields.forEach((field) => field.addEventListener('change', () => {
    const key = field.dataset.setting;
    settings = { ...settings, [key]: field.checked };
    updateControls();
    send({ type: 'settings', settings: { [key]: field.checked } });
  }));

  if (pauseButton) pauseButton.addEventListener('click', () => {
    settings.enabled = !settings.enabled;
    updateControls();
    send({ type: 'settings', settings: { enabled: settings.enabled } });
  });

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    requestAnimationFrame(() => {
      flushScheduled = false;
      const exactX = pendingDx + mouseRemainderX;
      const exactY = pendingDy + mouseRemainderY;
      const wholeX = Math.trunc(exactX);
      const wholeY = Math.trunc(exactY);
      mouseRemainderX = exactX - wholeX;
      mouseRemainderY = exactY - wholeY;
      if (wholeX || wholeY) {
        sendInput({ action: 'move', dx: wholeX, dy: wholeY });
      }
      if (Math.abs(pendingWheel) >= 1) sendInput({ action: 'wheel', delta: pendingWheel });
      pendingDx = 0;
      pendingDy = 0;
      pendingWheel = 0;
    });
  }

  trackpad.addEventListener('pointerdown', (event) => {
    if (!settings.enabled || !settings.mouse) return;
    event.preventDefault();
    trackpad.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    });
    if (pointers.size > 1) {
      for (const pointer of pointers.values()) pointer.moved = true;
      lastScrollY = averageY();
    }
  });

  function averageY() {
    const points = [...pointers.values()];
    return points.reduce((total, pointer) => total + pointer.y, 0) / points.length;
  }

  trackpad.addEventListener('pointermove', (event) => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || !settings.enabled || !settings.mouse) return;
    let samples = [event];
    try {
      const coalesced = event.getCoalescedEvents?.();
      if (coalesced?.length) samples = coalesced;
    } catch {}
    const lastSample = samples[samples.length - 1];
    if (lastSample.clientX !== event.clientX || lastSample.clientY !== event.clientY) samples = [...samples, event];
    let dx = 0;
    let dy = 0;
    for (const sample of samples) {
      dx += sample.clientX - pointer.x;
      dy += sample.clientY - pointer.y;
      pointer.x = sample.clientX;
      pointer.y = sample.clientY;
    }
    if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > 7) pointer.moved = true;

    if (pointers.size > 1) {
      const currentY = averageY();
      if (lastScrollY !== null && settings.scroll) pendingWheel += (lastScrollY - currentY) * 6;
      lastScrollY = currentY;
      scheduleFlush();
      return;
    }

    pendingDx += dx * mouseSensitivity;
    pendingDy += dy * mouseSensitivity;
    scheduleFlush();
  });

  function endPointer(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointers.delete(event.pointerId);
    try { trackpad.releasePointerCapture(event.pointerId); } catch {}
    if (pointers.size < 2) lastScrollY = null;
    if (pointers.size === 0 && !pointer.moved && settings.enabled && settings.mouse && settings.click && settings.tapClick) {
      clearTypedPreview();
      sendInput({ action: 'button', button: 'left', state: 'down' });
      sendInput({ action: 'button', button: 'left', state: 'up' });
    }
  }
  trackpad.addEventListener('pointerup', endPointer);
  trackpad.addEventListener('pointercancel', endPointer);
  trackpad.addEventListener('contextmenu', (event) => event.preventDefault());

  document.querySelectorAll('[data-mouse-button]').forEach((button) => {
    const mouseButton = button.dataset.mouseButton;
    const release = () => sendInput({ action: 'button', button: mouseButton, state: 'up' });
    button.addEventListener('pointerdown', (event) => {
      if (button.disabled) return;
      if (mouseButton === 'left') clearTypedPreview();
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      sendInput({ action: 'button', button: mouseButton, state: 'down' });
      button.classList.add('is-pressed');
    });
    button.addEventListener('pointerup', () => { release(); button.classList.remove('is-pressed'); });
    button.addEventListener('pointercancel', () => { release(); button.classList.remove('is-pressed'); });
    button.addEventListener('lostpointercapture', () => { release(); button.classList.remove('is-pressed'); });
  });

  function flushKeyboardQueue() {
    keyboardFlushScheduled = false;
    if (socket?.readyState !== WebSocket.OPEN || !keyboardQueue.length) return;
    while (keyboardQueue.length) {
      const packet = keyboardQueue.shift();
      if (packet.action === 'text') {
        let text = packet.text;
        while (keyboardQueue[0]?.action === 'text' && text.length + keyboardQueue[0].text.length <= 1200) {
          text += keyboardQueue.shift().text;
        }
        send({ type: 'input', action: 'text', text });
      } else {
        send({ type: 'input', ...packet });
      }
    }
  }

  function queueKeyboard(packet) {
    if (!settings.enabled || !settings.keyboard) return;
    keyboardQueue.push(packet);
    if (keyboardFlushScheduled) return;
    keyboardFlushScheduled = true;
    if (typeof queueMicrotask === 'function') queueMicrotask(flushKeyboardQueue);
    else Promise.resolve().then(flushKeyboardQueue);
  }

  function sendKey(key) {
    queueKeyboard({ action: 'key', key, state: 'down' });
    queueKeyboard({ action: 'key', key, state: 'up' });
  }

  const capsLockButton = document.querySelector('#caps-lock');
  capsLockButton.setAttribute('aria-pressed', 'false');
  function refreshKeyLabels() {
    document.querySelectorAll('.keycap-letter[data-char]').forEach((button) => {
      const normal = button.dataset.char;
      if (normal === ' ') return;
      const shifted = button.dataset.shiftChar || normal;
      const isLetter = /^[a-z]$/i.test(normal);
      const showShifted = isLetter ? capsLocked !== modifiers.has('Shift') : modifiers.has('Shift') && Boolean(button.dataset.shiftChar);
      button.textContent = showShifted ? shifted : normal;
    });
  }
  function updatePreviewForKey(key) {
    const control = modifiers.has('Control');
    if (modifiers.has('Alt') || modifiers.has('Meta')) return;
    if (key === 'Backspace') {
      if (control) removePreviewWord(true); else removePreviewCharacter();
    } else if (key === 'Delete') {
      if (control) removePreviewWord(false); else removePreviewNextCharacter();
    } else if (key === 'Enter' && modifiers.has('Shift')) addPreviewText('\n');
    else if (key === 'Enter' || key === 'Tab') clearTypedPreview();
    else if (key === 'ArrowLeft') movePreviewCursor(-1, control);
    else if (key === 'ArrowRight') movePreviewCursor(1, control);
    else if (key === 'Home') { typedPreviewCursor = 0; updateTypedPreview(); }
    else if (key === 'End') { typedPreviewCursor = splitCharacters(typedPreviewValue).length; updateTypedPreview(); }
  }
  document.querySelectorAll('[data-key]').forEach((button) => {
    const key = button.dataset.key;
    let repeatDelay;
    let repeatInterval;
    let repeatStarted = false;
    if (button.dataset.repeat === 'true') {
      const stopRepeating = () => {
        clearTimeout(repeatDelay);
        clearInterval(repeatInterval);
      };
      button.addEventListener('pointerdown', () => {
        if (button.disabled) return;
        repeatStarted = true;
        sendKey(key);
        updatePreviewForKey(key);
        flashKey(button, 'Backspace');
        repeatDelay = setTimeout(() => {
          repeatInterval = setInterval(() => {
            sendKey(key);
            updatePreviewForKey(key);
            flashKey(button, 'Backspace');
          }, 70);
        }, 420);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((name) => button.addEventListener(name, stopRepeating));
    }
    button.addEventListener('click', () => {
      if (repeatStarted) {
        repeatStarted = false;
        return;
      }
      if (key === 'CapsLock') {
        capsLocked = !capsLocked;
        capsLockButton.classList.toggle('is-active', capsLocked);
        capsLockButton.setAttribute('aria-pressed', String(capsLocked));
        refreshKeyLabels();
      }
      updatePreviewForKey(key);
      flashKey(button, key === 'CapsLock' ? 'Caps Lock' : button.textContent.trim() || key);
      sendKey(key);
    });
  });
  document.querySelectorAll('[data-modifier]').forEach((button) => button.addEventListener('click', () => {
    const key = button.dataset.modifier;
    const isDown = modifiers.has(key);
    if (isDown) modifiers.delete(key); else modifiers.add(key);
    document.querySelectorAll('[data-modifier]').forEach((modifierButton) => {
      if (modifierButton.dataset.modifier === key) {
        modifierButton.classList.toggle('is-active', !isDown);
        modifierButton.setAttribute('aria-pressed', String(!isDown));
      }
    });
    refreshKeyLabels();
    flashKey(button, `${key} ${isDown ? 'off' : 'on'}`);
    queueKeyboard({ action: 'key', key, state: isDown ? 'up' : 'down' });
  }));

  function sendText(value) {
    if (!value || !settings.enabled || !settings.keyboard) return;
    queueKeyboard({ action: 'text', text: value });
  }

  document.querySelectorAll('[data-char]').forEach((button) => button.addEventListener('click', () => {
    const normal = button.dataset.char;
    const shifted = button.dataset.shiftChar || normal;
    const shortcutKey = button.dataset.shortcutKey || normal;
    const shiftDown = modifiers.has('Shift');
    const letter = /^[a-z]$/i.test(normal);
    const useShift = letter ? capsLocked !== shiftDown : shiftDown;
    if (modifiers.has('Control') || modifiers.has('Alt') || modifiers.has('Meta')) {
      const addShift = !shiftDown && button.dataset.shortcutShift === 'true';
      if (addShift) queueKeyboard({ action: 'key', key: 'Shift', state: 'down' });
      sendKey(shortcutKey);
      if (addShift) queueKeyboard({ action: 'key', key: 'Shift', state: 'up' });
      const held = ['Control', 'Alt', 'Meta', ...(shiftDown ? ['Shift'] : [])].filter((key) => modifiers.has(key));
      flashKey(button, `${held.join('+')}+${shortcutKey}`);
    } else {
      const character = useShift ? shifted : normal;
      addPreviewText(character);
      sendText(character);
      flashKey(button, character === ' ' ? 'Space' : character);
    }
    if (shiftDown) {
      modifiers.delete('Shift');
      document.querySelectorAll('[data-modifier="Shift"]').forEach((shiftButton) => {
        shiftButton.classList.remove('is-active');
        shiftButton.setAttribute('aria-pressed', 'false');
      });
      refreshKeyLabels();
      queueKeyboard({ action: 'key', key: 'Shift', state: 'up' });
    }
  }));

  window.addEventListener('pagehide', () => {
    flushKeyboardQueue();
    for (const key of modifiers) send({ type: 'input', action: 'key', key, state: 'up' });
    send({ type: 'input', action: 'reset' });
  });

  updateConnection(false, 'Connecting…');
  connect();
})();
