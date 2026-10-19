// Paste into DevTools Console on https://console.mistral.ai after signing in.
// Downloads credentials locally; makes no requests and never prints cookie values.
// HttpOnly cookies are inaccessible to JavaScript: use DevTools manually if needed.
(() => {
  'use strict';
  if (location.origin !== 'https://console.mistral.ai') {
    throw new Error('Run this only on https://console.mistral.ai after signing in.');
  }
  const cookies = new Map();
  for (const part of document.cookie.split(';')) {
    const entry = part.trim();
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const name = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (name !== 'csrftoken' && !/^ory_session_[A-Za-z0-9_-]+$/.test(name)) continue;
    if (cookies.has(name)) throw new Error('Duplicate auth cookie names; select the correct scope manually in DevTools.');
    if (!value || /[\x00-\x20\x7f;,]/.test(value)) throw new Error('Invalid auth cookie format; no file exported.');
    cookies.set(name, value);
  }
  const csrfToken = cookies.get('csrftoken');
  const sessionCookies = Object.fromEntries([...cookies].filter(([name]) => name !== 'csrftoken'));
  if (!csrfToken || Object.keys(sessionCookies).length === 0) {
    throw new Error('Required cookies are not readable. Sign in first. If the session cookie is HttpOnly, copy it manually from DevTools Application → Cookies; console JavaScript cannot export it. No file exported.');
  }
  const json = JSON.stringify({ csrfToken, sessionCookies }, null, 2);
  if (Object.keys(sessionCookies).length > 8 || new Blob([json]).size > 16384) {
    throw new Error('Auth data exceeds the gateway limits; no file exported.');
  }
  if (!confirm('Download a sensitive Mistral session credential file? Keep it private; do not share it in chat or commit it.')) return;
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '.mistral-session.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  console.info('Credential download requested. Restrict the downloaded file to mode 600 before upload.');
})();
