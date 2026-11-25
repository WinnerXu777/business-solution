(() => {
  'use strict';
  const script = document.currentScript;
  const tenant = script?.dataset.tenant;
  if (!tenant) return;
  const base = new URL('./widget/', script.src);
  const host = document.createElement('div');
  (document.body ?? document.documentElement).append(host);
  const root = host.attachShadow({ mode: 'open' });
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Support chat';
  toggle.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('section');
  panel.setAttribute('aria-label', 'Support chat');
  panel.hidden = true;
  const log = document.createElement('ol');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Messages');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.setAttribute('aria-label', 'Message');
  input.maxLength = 4096;
  input.required = true;
  const send = document.createElement('button');
  send.textContent = 'Send';
  const handoff = document.createElement('button');
  handoff.type = 'button';
  handoff.textContent = 'Talk to a person';
  form.append(input, send);
  panel.append(log, status, form, handoff);
  root.append(toggle, panel);

  let session;
  let starting = false;
  let after = 0;
  let typing = false;
  let idle;
  let latestRead;
  let reportedRead;
  let reading = false;
  let state = 'bot';
  let reconnect;
  const routing = {
    bot: '',
    queued: 'Waiting for support',
    assigned: 'Connected to support',
    resolved: 'Conversation closed',
  };

  async function request(path, { method = 'GET', body, signal, cursor } = {}) {
    const url = new URL(path, base);
    url.searchParams.set('tenant', tenant);
    const headers = {};
    if (session) headers.authorization = 'Bearer ' + session.token;
    if (body) headers['content-type'] = 'application/json';
    if (cursor) headers['last-event-id'] = String(cursor);
    const response = await fetch(url, {
      method,
      headers,
      signal,
      body: body && JSON.stringify(body),
    });
    if (!response.ok) throw new Error(String(response.status));
    return response;
  }

  const post = (path, body) => request(path, { method: 'POST', body });
  function renderState() {
    input.disabled = !session || state === 'resolved';
    send.disabled = input.disabled;
    handoff.disabled = !session || state !== 'bot';
    status.textContent = routing[state];
  }

  async function markRead() {
    if (
      reading ||
      !latestRead ||
      latestRead === reportedRead ||
      panel.hidden ||
      document.hidden ||
      state === 'resolved'
    )
      return;
    const messageId = latestRead;
    reading = true;
    try {
      await post('events', { type: 'read', messageId });
      reportedRead = messageId;
    } catch {
      return;
    } finally {
      reading = false;
    }
    if (latestRead !== reportedRead) void markRead();
  }

  function receive(event) {
    after = event.cursor;
    if (event.type === 'message') {
      const line = document.createElement('li');
      const { role, text, id } = event.message;
      const speaker = { customer: 'You', staff: 'Support', bot: 'Automated assistant' }[role];
      line.textContent = speaker + ': ' + text;
      log.append(line);
      if (role !== 'customer') {
        latestRead = id;
        void markRead();
      }
    } else if (event.type === 'state') {
      state = event.state;
      renderState();
    } else if (event.type === 'typing' && event.role === 'staff') {
      status.textContent = event.active ? 'Support is typing…' : routing[state];
    }
  }

  async function listen() {
    let delay = 500;
    while (session) {
      try {
        const remaining = session.expiresAt - Date.now();
        if (remaining < 30_000) session = await (await post('session')).json();
        reconnect = new AbortController();
        const life = session.expiresAt - Date.now();
        const timer = setTimeout(
          () => reconnect.abort(),
          Math.max(500, life - Math.min(30_000, life / 4)),
        );
        try {
          const response = await request('stream', { signal: reconnect.signal, cursor: after });
          await markRead();
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let pending = '';
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              delay = 500;
              pending += value;
              let boundary;
              while ((boundary = pending.indexOf('\n\n')) >= 0) {
                const data = pending
                  .slice(0, boundary)
                  .split('\n')
                  .find((line) => line.startsWith('data: '));
                pending = pending.slice(boundary + 2);
                if (data) receive(JSON.parse(data.slice(6)));
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (error.message === '401' || error.message === '403') {
          session = undefined;
          renderState();
          status.textContent = 'Chat session ended. Reload this page to start again.';
          return;
        }
        if (!reconnect?.signal.aborted) status.textContent = 'Reconnecting…';
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }

  function setTyping(active) {
    if (typing === active || !session || state === 'resolved') return;
    typing = active;
    void post('events', { type: 'typing', active }).catch(() => {});
  }

  input.addEventListener('input', () => {
    setTyping(Boolean(input.value));
    clearTimeout(idle);
    idle = setTimeout(() => setTyping(false), 1500);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true;
    setTyping(false);
    try {
      await post('messages', { text });
      if (input.value.trim() === text) input.value = '';
    } catch {
      status.textContent = 'Message unavailable. Try again.';
    } finally {
      send.disabled = !session || state === 'resolved';
    }
  });
  handoff.addEventListener('click', async () => {
    handoff.disabled = true;
    try {
      await post('handoff');
    } catch {
      status.textContent = 'Could not request support. Try again.';
      handoff.disabled = !session || state !== 'bot';
    }
  });
  toggle.addEventListener('click', async () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (panel.hidden) {
      setTyping(false);
      return;
    }
    if (session) {
      input.focus();
      void markRead();
      return;
    }
    if (starting || after) return;
    starting = true;
    try {
      session = await (await post('session')).json();
      renderState();
      input.focus();
      void listen();
    } catch {
      status.textContent = 'Chat unavailable. Close and reopen to try again.';
    } finally {
      starting = false;
    }
  });
  document.addEventListener('visibilitychange', () => void markRead());
  renderState();
})();
