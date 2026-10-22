// Settings: account, pod, inbox relays, appearance, profile, media server, blocked,
// notifications.
import { useState, useEffect, useRef } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, copy, fail, html, setTheme, shareLink, theme, useAction } from './common.js';
import { playSound } from './sounds.js';
const { me, profiles, inboxRelays } = store;

export function Settings() {
  const signer = me.value;
  const [showKey, setShowKey] = useState(false);
  const inbox = useAction();
  const relays = inboxRelays.value;
  return html`<section class="main scroll">
    <header class="bar"><a class="back" href="#">‹</a><div class="title"><b>Settings</b></div></header>
    <div class="forms">
      <div class="card">
        <h3>Account</h3>
        <p class="mono wrap">${nostr.did(signer.pubkey)}</p>
        <p class="muted small">Your identity is this did:nostr. Anyone can resolve it at nostr.social.</p>
        <div class="buttons">
          <button onClick=${() => copy(nostr.did(signer.pubkey), 'DID copied')}>Copy DID</button>
          <button onClick=${() => copy(nostr.npub(signer.pubkey), 'npub copied')}>Copy npub</button>
          <button class="primary" onClick=${() => shareLink(nostr.chatLink(signer.pubkey), 'Message me on Solid Chat')}>Share my link</button>
          <a class="button" href=${nostr.profileUrl(signer.pubkey)} target="_blank" rel="noopener">nostr.social ↗</a>
          <a class="button" href=${nostr.didDocumentUrl(signer.pubkey)} target="_blank" rel="noopener">DID document ↗</a>
        </div>
        <p class="muted small">Signed in with ${signer.type === 'nsec' ? 'a private key' : signer.type === 'bunker' ? 'a remote signer' : 'a browser extension'}.</p>
        ${signer.type === 'nsec' &&
        html`<div>
          ${showKey
            ? html`<p class="mono wrap secret">${nostr.exportNsec(signer)}</p>`
            : html`<button onClick=${() => setShowKey(true)}>Reveal private key (nsec)</button>`}
        </div>`}
      </div>
      <${PodSettings} />
      <div class="card">
        <h3>DM inbox relays</h3>
        ${relays === null
          ? html`<p class="muted">Checking…</p>`
          : relays.length
            ? html`<ul>${relays.map((r) => html`<li class="mono">${r}</li>`)}</ul>`
            : html`<p class="muted">You have no NIP-17 inbox relays published, so some clients can't reach you.</p>
                <button disabled=${inbox.busy} onClick=${() => inbox.run(store.publishDefaultInbox)}>Publish default inbox relays</button>`}
        ${inbox.error && html`<p class="error">${inbox.error}</p>`}
      </div>
      <div class="card">
        <h3>Appearance</h3>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          ${[
            ['system', 'System'],
            ['light', '☀️ Light'],
            ['dark', '🌙 Dark'],
          ].map(
            ([value, label]) => html`<button role="radio" aria-checked=${theme.value === value} class=${theme.value === value ? 'on' : ''} onClick=${() => setTheme(value)}>${label}</button>`,
          )}
        </div>
      </div>
      <${ProfileSettings} />
      <${MediaServerSettings} />
      <${RelaySettings} />
      <${BlockedSettings} />
      <${NotificationSettings} />
      <div class="card">
        <h3>Privacy</h3>
        <p class="muted small">
          Direct messages are end-to-end encrypted. Chat rooms are stored in the open on the pod that hosts them. Pods, relays, the
          nostr.social directory (profiles and search), the media server and the hosts of pictures you open can see your IP address.
          <a href="privacy" target="_blank" rel="noopener noreferrer">Full details ↗</a>
        </p>
      </div>
      <div class="card">
        <button class="danger" onClick=${store.logout}>Sign out of this account</button>
      </div>
    </div>
  </section>`;
}

function ProfileSettings() {
  const pk = me.value.pubkey;
  const p = profiles.value[pk] ?? {};
  const [form, setForm] = useState({ name: p.name ?? '', about: p.about ?? '', picture: p.picture ?? '', website: p.website ?? '', nip05: p.nip05 ?? '' });
  const save = useAction();
  const upload = useAction();
  const fileInput = useRef();
  const field = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  return html`<form class="card profile-form" onSubmit=${(e) => {
    e.preventDefault();
    save.run(async () => {
      if (form.picture && !/^https:\/\//.test(form.picture)) throw new Error('The picture must be an https:// link.');
      if (form.website && !/^https:\/\//.test(form.website)) throw new Error('The website must be an https:// link.');
      await store.saveProfile(form);
      store.notify('Profile saved');
    });
  }}>
    <h3>Profile</h3>
    <div class="profile-head">
      ${form.picture ? html`<img class="avatar" src=${form.picture} width="64" height="64" referrerpolicy="no-referrer" alt="" />` : html`<${Avatar} pubkey=${pk} size=${64} />`}
      <button type="button" disabled=${upload.busy} onClick=${() => fileInput.current.click()}>${upload.busy ? 'Uploading…' : 'Upload picture'}</button>
      <input ref=${fileInput} type="file" accept="image/*" hidden onChange=${(e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) upload.run(async () => setForm({ ...form, picture: (await store.uploadMedia(file))[1].slice(4) }));
      }} />
    </div>
    <label>Name<input maxlength="80" value=${form.name} onInput=${field('name')} placeholder="How people see you" /></label>
    <label>Bio<textarea rows="3" maxlength="600" value=${form.about} onInput=${field('about')} placeholder="A few words about you" /></label>
    <label>Picture link<input value=${form.picture} onInput=${field('picture')} placeholder="https://…" /></label>
    <label>Website<input value=${form.website} onInput=${field('website')} placeholder="https://…" /></label>
    <label>NIP-05 address<input value=${form.nip05} onInput=${field('nip05')} placeholder="you@example.com" /></label>
    <p class="muted small">Public: published as your Nostr profile (kind 0), visible in every Nostr app. Other fields set elsewhere are kept.</p>
    ${(save.error || upload.error) && html`<p class="error">${save.error || upload.error}</p>`}
    <button class="primary" disabled=${save.busy}>${save.busy ? 'Saving…' : 'Save profile'}</button>
  </form>`;
}

function MediaServerSettings() {
  const [value, setValue] = useState(store.mediaServer.value);
  const save = useAction();
  return html`<form class="card" onSubmit=${(e) => {
    e.preventDefault();
    save.run(async () => {
      store.setMediaServer(value);
      store.notify('Media server saved');
    });
  }}>
    <h3>Media server</h3>
    <p class="muted small">Photos and videos you send are uploaded unencrypted to this Blossom server; anyone with the link can view them.</p>
    <input value=${value} onInput=${(e) => setValue(e.target.value)} placeholder=${nostr.DEFAULT_BLOSSOM} />
    ${save.error && html`<p class="error">${save.error}</p>`}
    <button disabled=${save.busy}>Save</button>
  </form>`;
}

// NIP-17 inbox relays: where others deliver your DMs. Suggestions come from
// nostr.social's relay health directory (public relays ranked by uptime and latency).
function RelaySettings() {
  const current = store.inboxRelays.value;
  const [list, setList] = useState(null); // null = not editing
  const [draft, setDraft] = useState('');
  const save = useAction();
  const editing = list ?? current ?? [];
  useEffect(() => store.loadRelayDirectory(), []);
  const suggestions = (store.relayDirectory.value ?? []).filter((r) => !editing.includes(r.url) && !r.requiresPayment).slice(0, 8);
  const add = (url) => {
    const n = nostr.normalizeRelay(url.trim());
    if (!n) return store.notify('Enter a wss:// relay address.');
    if (!editing.includes(n)) setList([...editing, n]);
    setDraft('');
  };
  const dirty = list && (list.length !== (current ?? []).length || list.some((r, i) => r !== current?.[i]));
  return html`<div class="card relays">
    <h3>Inbox relays</h3>
    <p class="muted small">Where other people deliver your encrypted messages (NIP-17). Pick two or three reliable ones; they are published signed by your key, with a matching relay list for other apps and your did:nostr document.</p>
    ${current === null && html`<p class="muted small">Loading your current list…</p>`}
    ${current?.length === 0 && !list && html`<p class="error">You haven't published inbox relays yet, so people can only reach you through the shared app relays.</p>`}
    <ul class="relay-list">
      ${editing.map((r) => html`<li key=${r}><span class="mono">${r.replace(/^wss:\/\//, '')}</span>
        <button class="link" title="Remove" aria-label=${`Remove ${r}`} onClick=${() => setList(editing.filter((x) => x !== r))}>✕</button></li>`)}
    </ul>
    <form class="row" onSubmit=${(e) => { e.preventDefault(); add(draft); }}>
      <input value=${draft} placeholder="wss://relay.example.com" onInput=${(e) => setDraft(e.target.value)} />
      <button type="submit" disabled=${!draft.trim()}>Add</button>
    </form>
    ${suggestions.length > 0 && html`<details class="suggestions">
      <summary>Suggested relays <small class="muted">from nostr.social's health checks</small></summary>
      ${suggestions.map((r) => html`<div class="suggestion" key=${r.url}>
        <span class="mono">${r.url.replace(/^wss:\/\//, '')}</span>
        <small class="muted">${r.uptime}% up · ${r.responseTime} ms${r.requiresAuth ? ' · auth' : ''}</small>
        <button class="link" onClick=${() => add(r.url)}>+ Add</button>
      </div>`)}
    </details>`}
    ${save.error && html`<p class="error">${save.error}</p>`}
    <div class="row">
      <button class="primary" disabled=${save.busy || !dirty} onClick=${() => save.run(async () => {
        await store.saveInboxRelays(editing);
        setList(null);
        store.notify('Inbox relays published');
      })}>${save.busy ? 'Publishing…' : 'Publish'}</button>
      ${dirty && html`<button class="link" onClick=${() => setList(null)}>Cancel</button>`}
    </div>
  </div>`;
}

function BlockedSettings() {
  const list = store.blocked.value;
  useEffect(() => store.requestProfiles(list), [list.length]);
  return html`<div class="card">
    <h3>Blocked</h3>
    ${list.length === 0 && html`<p class="muted small">You haven't blocked anyone.</p>`}
    ${list.map(
      (pk) => html`<div class="item blocked-row" key=${pk}>
        <${Avatar} pubkey=${pk} size=${32} />
        <span class="label"><b>${store.displayName(pk)}</b><small class="mono">${nostr.shortKey(pk)}</small></span>
        <button onClick=${() => store.toggleBlock(pk).catch(fail('Unblock'))}>Unblock</button>
      </div>`,
    )}
    <p class="muted small">Blocks are kept in your encrypted Nostr mute list, shared with Anagram and nostr.chat.</p>
  </div>`;
}

function NotificationSettings() {
  const n = store.notifySettings.value;
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  return html`<div class="card">
    <h3>Notifications</h3>
    <p class="muted small">While this tab is open. There is no push server, so nothing arrives when it's closed.</p>
    <label class="check"><input type="checkbox" checked=${n.dms} onChange=${(e) => store.setNotifySettings({ dms: e.target.checked })} /> Direct messages</label>
    <label class="check">Rooms
      <select value=${n.rooms} onChange=${(e) => store.setNotifySettings({ rooms: e.target.value })}>
        <option value="mentions">Mentions and replies</option>
        <option value="all">All messages</option>
        <option value="off">Off</option>
      </select>
    </label>
    <label class="check"><input type="checkbox" checked=${n.sound} onChange=${(e) => store.setNotifySettings({ sound: e.target.checked })} /> Sounds
      <button type="button" class="link" title="Play the message sound" onClick=${() => playSound('dm', { force: true })}>Preview</button></label>
    ${permission === 'granted'
      ? html`<p class="muted small">Desktop notifications are on (shown when the tab is in the background).</p>`
      : permission === 'denied'
        ? html`<p class="muted small">Desktop notifications are blocked in your browser's site settings.</p>`
        : permission === 'unsupported'
          ? html`<p class="muted small">This browser doesn't support desktop notifications.</p>`
          : html`<button onClick=${() => Notification.requestPermission().then(setPermission)}>Enable desktop notifications</button>`}
  </div>`;
}

// The pod folder new chats are created in. Your Nostr key must be allowed to write there:
// on JSS, add it to your WebID profile as a verification method, or grant did:nostr:<hex>
// in the folder's ACL.
function PodSettings() {
  const [value, setValue] = useState(store.podUrl.value);
  const save = useAction();
  return html`<form class="card" onSubmit=${(e) => {
    e.preventDefault();
    save.run(async () => {
      store.setPodUrl(value);
      store.notify(value.trim() ? 'Pod folder saved' : 'Pod folder cleared');
    });
  }}>
    <h3>Your pod</h3>
    <p class="muted small">New chats you create are made as folders inside this one, on a Solid pod where your key may write (for example a pod on
      <a href="https://github.com/JavaScriptSolidServer/JavaScriptSolidServer" target="_blank" rel="noopener noreferrer">JSS</a>, which understands
      did:nostr). Chats other people host need no pod at all.</p>
    <input value=${value} onInput=${(e) => setValue(e.target.value)} placeholder="https://your.pod/public/chats/" />
    ${save.error && html`<p class="error">${save.error}</p>`}
    <button disabled=${save.busy}>Save</button>
  </form>`;
}
