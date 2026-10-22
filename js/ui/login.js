// The signed-out screen: landing page around the sign-in card (extension, key, bunker,
// new account); the plain card when adding a second account.
import { useState } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { html, useAction } from './common.js';
const { me } = store;

export function Login() {
  const [mode, setMode] = useState(window.nostr ? 'extension' : 'nsec');
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  const [authUrl, setAuthUrl] = useState('');
  const [newName, setNewName] = useState('');
  const { busy, error, run } = useAction();

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const signer =
        mode === 'nsec'
          ? nostr.nsecSigner(value)
          : mode === 'extension'
            ? await nostr.extensionSigner()
            : mode === 'bunker'
              ? await nostr.bunkerSigner(value, setAuthUrl)
              : nostr.newKeySigner();
      await store.login(signer, remember);
      if (mode === 'new') store.setUpNewAccount(newName).catch((e) => store.notify(`Profile setup failed: ${e.message}`));
    });
  };

  const tabs = [
    ['extension', 'Extension'],
    ['nsec', 'Private key'],
    ['bunker', 'Bunker'],
    ['new', 'New account'],
  ];
  const adding = !!me.value;
  const form = html`<form class="card" onSubmit=${submit}>
      ${adding
        ? html`<h1>Solid Chat</h1><p class="muted">Add another account.</p>`
        : html`<h2>Open Solid Chat</h2><p class="muted">One tap with a signer extension, or bring a key. New here? Make an account in seconds.</p>`}
      <div class="tabs">
        ${tabs.map(
          ([id, label]) =>
            html`<button type="button" class=${mode === id ? 'on' : ''} onClick=${() => setMode(id)}>${label}</button>`,
        )}
      </div>
      ${mode === 'nsec' &&
      html`<input type="password" autocomplete="off" placeholder="nsec1…" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'bunker' &&
      html`<input placeholder="bunker://… or name@domain" value=${value} onInput=${(e) => setValue(e.target.value)} />`}
      ${mode === 'extension' &&
      html`<p class="muted">${window.nostr ? 'Sign in with your browser extension (needs NIP-44).' : 'No extension detected.'}</p>`}
      ${mode === 'new' &&
      html`<input placeholder="Your name" maxlength="80" value=${newName} onInput=${(e) => setNewName(e.target.value)} />
        <p class="muted">Generates a fresh key in this browser. Back it up from Settings afterwards.</p>`}
      ${mode !== 'extension' &&
      html`<label class="check"><input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.target.checked)} /> Stay signed in on this device</label>`}
      ${mode === 'nsec' && remember && html`<p class="muted small">Your key will be stored unencrypted in this browser.</p>`}
      ${authUrl && html`<p>Approve in your signer: <a href=${authUrl} target="_blank" rel="noopener">${authUrl}</a></p>`}
      ${error && html`<p class="error">${error}</p>`}
      <button class="primary" disabled=${busy}>${busy ? 'Connecting…' : me.value ? 'Add account' : 'Sign in'}</button>
      ${me.value && html`<button type="button" onClick=${() => (store.addingAccount.value = false)}>Cancel</button>`}
      ${!me.value && store.wantLogin.value && html`<button type="button" onClick=${() => (store.wantLogin.value = false)}>Back to the chat</button>`}
    </form>`;
  if (adding) return html`<main class="login">${form}</main>`;
  return html`<main class="login landing">
    <div class="landing-wrap">
      <div class="landing-head"><img src="icon.svg" width="28" height="28" alt="" /> Solid Chat</div>
      <section class="hero">
        <div class="pitch">
          <h1>Chat that lives on your pod.</h1>
          <p class="lead">Chat rooms are folders on a Solid pod, in the open standard Solid chat format, readable by any Solid app. Direct messages are end-to-end encrypted over Nostr. One key signs in to both.</p>
          <div class="pills"><span>📂 Rooms on pods</span><span>🔒 Encrypted DMs</span><span>🪪 did:nostr</span></div>
          <div class="mock" aria-hidden="true">
            <div class="mock-head"><span class="avatar room">#</span><span><b>Lobby</b><small>alice.pod.example</small></span></div>
            <div class="mock-day">Today</div>
            <div class="mock-msg theirs">Is this really stored on your pod? 👀<time>09:41</time></div>
            <div class="mock-msg mine">Yes. A Turtle file per day, in a folder I control.<time>09:42 ✓</time></div>
            <div class="mock-msg theirs">And I can read it from SolidOS too?<time>09:42</time></div>
            <div class="mock-msg mine">Same chat, any Solid app. Your key is your identity.<time>09:43 ✓</time></div>
          </div>
        </div>
        ${form}
      </section>
      <section class="features">
        <div><h3>Your data, your pod.</h3><p>A chat is a folder on a Solid pod: an index file and one file per day, in the <a href="https://solid.github.io/chat/" target="_blank" rel="noopener">Solid chat</a> format. Move the folder, keep the chat.</p></div>
        <div><h3>One key, two worlds.</h3><p>Your identity is a Nostr key with a <a href="https://did-nostr.com" target="_blank" rel="noopener">did:nostr</a> address. Pods that speak NIP-98 (such as <a href="https://github.com/JavaScriptSolidServer/JavaScriptSolidServer" target="_blank" rel="noopener">JSS</a>) know it; so does every Nostr app.</p></div>
        <div><h3>Private messages stay private.</h3><p>Direct messages are NIP-17 gift wraps over Nostr relays, end-to-end encrypted, compatible with Anagram and nostr.chat.</p></div>
        <div><h3>Live, not polled.</h3><p>Rooms update over the pod's own live-update socket. Reply, react, edit, attach pictures, from any browser.</p></div>
        <div><h3>Nothing to install.</h3><p>Static files served from one place, no third-party scripts, no account server. Add it to your home screen on a phone.</p></div>
        <div><h3>Open to other apps.</h3><p>People posting from SolidOS or other Solid chat apps show up by their WebID; you post as your did:nostr. The format is the same.</p></div>
      </section>
      <section class="faq">
        <h2>Questions</h2>
        <details><summary>Where do I get a pod?</summary><p>Any Solid pod that lets your key write works for creating chats; <a href="https://github.com/JavaScriptSolidServer/JavaScriptSolidServer" target="_blank" rel="noopener">JSS</a> accepts Nostr keys directly. To join chats other people host you need no pod at all.</p></details>
        <details><summary>Who can read a room?</summary><p>Whoever the folder's permissions allow. Rooms created here are readable and postable by anyone with the link; only the owner can edit or delete. Rooms are not encrypted.</p></details>
        <details><summary>Is this the old Solid Chat?</summary><p>It is a clean rewrite with the same chat format, so chats made with the earlier app and with SolidOS open here too.</p></details>
        <details><summary>What leaves my device?</summary><p>Only what the <a href="privacy">Privacy page</a> lists: requests to the pods that host your chats, relay traffic for DMs, profile lookups, and files you choose to upload.</p></details>
      </section>
      <p class="landing-partners">Works with <a href="https://solidproject.org" target="_blank" rel="noopener">Solid</a> pods, <a href="https://github.com/lnbits/anagram" target="_blank" rel="noopener">Anagram</a> and <a href="https://nostr.chat" target="_blank" rel="noopener">nostr.chat</a> DMs. One key, open formats, your choice of app.</p>
      <footer class="landing-foot">
        <span>Solid Chat is free software (AGPL-3.0). Rooms in the Solid chat format; DMs encrypted with NIP-44 and NIP-17 gift wrap.</span>
        <nav>
          <a href="https://github.com/solid-chat/v2" target="_blank" rel="noopener">Source</a>
          <a href="privacy">Privacy</a>
          <a href="security">Security</a>
          <a href="https://solid-chat.com" target="_blank" rel="noopener">solid-chat.com</a>
          <a href="https://did-nostr.com" target="_blank" rel="noopener">did:nostr</a>
        </nav>
      </footer>
    </div>
  </main>`;
}
