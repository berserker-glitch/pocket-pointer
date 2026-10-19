(() => {
  const query = new URLSearchParams(location.search);
  const pin = query.get('pin') || sessionStorage.getItem('pocket-pointer-pin') || '';
  if (query.get('pin')) sessionStorage.setItem('pocket-pointer-pin', pin);

  const fields = [...document.querySelectorAll('[data-setting]')];
  const qr = document.querySelector('#qr-code');
  const qrPlaceholder = document.querySelector('#qr-placeholder');
  const addressValue = document.querySelector('#address-value');
  const addressOptions = document.querySelector('#address-options');
  const copyButton = document.querySelector('#copy-link');
  const copyFeedback = document.querySelector('#copy-feedback');
  const pairCode = document.querySelector('#pair-code');
  const pairHint = document.querySelector('#pair-hint');
  const hostIndicator = document.querySelector('#host-indicator');
  const hostLabel = document.querySelector('#host-label');
  const enabledCount = document.querySelector('#enabled-count');
  let socket;
  let currentUrls = [];
  let activeUrl = null;
  let retryTimer;

  const keys = ['enabled', 'mouse', 'keyboard', 'scroll', 'click', 'tapClick'];
  let settings = { enabled: true, mouse: true, keyboard: true, scroll: true, click: true, tapClick: true };

  function setConnection(connected, controllers = 0) {
    hostIndicator.classList.toggle('online', connected);
    hostLabel.textContent = connected ? (controllers ? `PC ready · ${controllers} phone${controllers === 1 ? '' : 's'}` : 'PC ready') : 'Bridge offline';
  }

  function applySettings(next) {
    if (!next) return;
    settings = { ...settings, ...next };
    for (const field of fields) field.checked = Boolean(settings[field.dataset.setting]);
    const active = settings.enabled ? keys.filter((key) => key !== 'enabled' && settings[key]).length : 0;
    enabledCount.textContent = String(active);
  }

  function chooseUrl(url) {
    activeUrl = url;
    addressValue.textContent = url ? url.link.replace(/^http:\/\//, '') : 'Waiting for the Windows bridge…';
    copyButton.disabled = !url;
    if (url?.qr) {
      qr.src = url.qr;
      qr.hidden = false;
      qrPlaceholder.hidden = true;
    } else {
      qr.hidden = true;
      qrPlaceholder.hidden = false;
    }
    for (const button of addressOptions.querySelectorAll('button')) {
      button.classList.toggle('selected', button.dataset.ip === url?.ip);
    }
  }

  function renderAddresses(urls) {
    const fresh = Array.isArray(urls) ? urls : [];
    currentUrls = fresh;
    addressOptions.replaceChildren();
    for (const address of fresh) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'address-chip';
      chip.textContent = address.ip;
      chip.dataset.ip = address.ip;
      chip.addEventListener('click', () => chooseUrl(address));
      addressOptions.append(chip);
    }
    const selected = fresh.find((item) => item.ip === activeUrl?.ip) || fresh[0] || null;
    chooseUrl(selected);
    if (fresh.length > 1) pairHint.textContent = 'Choose the Wi-Fi address your phone can reach, then scan the code.';
    else if (fresh.length === 1) pairHint.textContent = 'Keep your phone on the same Wi-Fi and scan this code.';
    else pairHint.textContent = 'Start the bridge on your PC to create a phone link.';
  }

  async function refreshStatus() {
    if (!pin) {
      pairCode.textContent = 'NO CODE';
      pairHint.textContent = 'Open the PC dashboard from start.ps1 to load your pairing code.';
      return;
    }
    pairCode.textContent = pin.replace(/(.{4})/, '$1 ');
    try {
      const response = await fetch(`/api/status?pin=${encodeURIComponent(pin)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Pairing code was rejected. Restart with start.ps1.');
      const status = await response.json();
      setConnection(status.hostConnected, status.controllers);
      applySettings(status.settings);
      renderAddresses(status.urls);
    } catch (error) {
      pairHint.textContent = error.message || 'The local service is not responding yet.';
      setConnection(false);
      renderAddresses([]);
    }
  }

  function connect() {
    if (!pin) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'pair', pin, client: 'dashboard' })));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'paired' || message.type === 'status') {
        setConnection(message.hostConnected, message.controllers);
        applySettings(message.settings);
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, 1800);
    });
  }

  fields.forEach((field) => {
    field.addEventListener('change', () => {
      const name = field.dataset.setting;
      settings = { ...settings, [name]: field.checked };
      applySettings(settings);
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'settings', settings: { [name]: field.checked } }));
    });
  });

  copyButton.addEventListener('click', async () => {
    if (!activeUrl) return;
    try {
      await navigator.clipboard.writeText(activeUrl.link);
      copyFeedback.textContent = 'Link copied';
      setTimeout(() => { copyFeedback.textContent = ''; }, 1700);
    } catch {
      copyFeedback.textContent = 'Copy is unavailable in this browser';
    }
  });

  refreshStatus();
  connect();
  setInterval(refreshStatus, 3500);
})();
