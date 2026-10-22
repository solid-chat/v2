// Chat info panels: person (profile, DID, block) and room (people, access, leave).
import { useEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, ConfirmButton, Field, RoomAvatar, copy, fail, html, infoOpen, openProfile, shareLink, viewer } from './common.js';
import { mediaOf } from './text.js';
const { me, profiles, joinedRooms } = store;

function SharedMedia({ messages, allowed }) {
  const urls = messages
    .filter((m) => allowed(m.pubkey))
    .flatMap(mediaOf)
    .filter((m) => m.kind === 'image')
    .map((m) => m.url)
    .reverse()
    .slice(0, 30);
  if (!urls.length) return null;
  return html`<section>
    <h4>Shared media</h4>
    <div class="shared">
      ${urls.map((u) => html`<img src=${u} loading="lazy" referrerpolicy="no-referrer" alt="" onClick=${() => (viewer.value = u)} />`)}
    </div>
  </section>`;
}


function ChatToggles({ chatKey }) {
  return html`<section class="toggles">
    <label class="check"><input type="checkbox" checked=${store.isPinned(chatKey)} onChange=${() => store.togglePinned(chatKey)} /> 📌 Pin to top</label>
    <label class="check"><input type="checkbox" checked=${store.isMuted(chatKey)} onChange=${() => store.toggleMuted(chatKey)} /> 🔕 Mute notifications</label>
  </section>`;
}

// The person's did:nostr identity, resolved from nostr.social (did-nostr.com).
function DidIdentity({ pubkey }) {
  const entry = store.didDocs.value[pubkey];
  useEffect(() => {
    store.resolveDid(pubkey);
  }, [pubkey]);
  const count = (n) => (n == null ? '—' : n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
  const links = (entry?.alsoKnownAs ?? []).filter((u) => /^https:\/\//.test(u));
  const relays = (entry?.service ?? []).map((s) => (typeof s.serviceEndpoint === 'string' ? s.serviceEndpoint : '')).filter(Boolean);
  return html`<section class="did">
    <h4>did:nostr identity</h4>
    ${!entry && html`<p class="muted small">Resolving…</p>`}
    ${entry?.error && html`<p class="muted small">Not resolved: ${entry.error}</p>`}
    ${entry?.doc &&
    html`<div class="did-stats">
        <span><b>${count(entry.following)}</b> following</span>
        <span><b>${count(entry.followers)}</b> followers</span>
        <span title="The DID document's key matches this account">${entry.keyMatches ? '🔑 key matches' : '⚠ key mismatch'}</span>
      </div>
      ${links.length > 0 && html`<${Field} label="Also known as" value=${links.map((u) => html`<a href=${u} target="_blank" rel="noopener noreferrer">${u.replace(/^https:\/\//, '')}</a> `)} />`}
      ${relays.length > 0 && html`<${Field} label="Relays" value=${relays.map((r) => r.replace(/^wss:\/\//, '')).join(', ')} />`}`}
    <div class="buttons">
      <button onClick=${() => shareLink(nostr.chatLink(pubkey), `${store.displayName(pubkey)} on Solid Chat`)}>Share contact</button>
      <a class="button" href=${nostr.profileUrl(pubkey)} target="_blank" rel="noopener">nostr.social ↗</a>
      <a class="button" href=${nostr.didDocumentUrl(pubkey)} target="_blank" rel="noopener">DID document ↗</a>
    </div>
  </section>`;
}

// NIP-05 under a person's name: verified ✓, or the claimed address with a Verify tap
// (checking it contacts their domain), or a failed mark.
function Nip05Line({ pubkey }) {
  const verified = store.verifiedNip05(pubkey); // auto-verifies people you already deal with
  const { state, address } = store.nip05State(pubkey);
  if (state === 'none') return null;
  if (verified) return html`<small class="muted" title="Verified NIP-05 address">✓ ${address}</small>`;
  if (state === 'failed') return html`<small class="muted nip05-failed" title="This address does not point to this key">✗ ${address}</small>`;
  return html`<small class="muted nip05-unchecked">
    ${address}
    ${state === 'checking' ? html` · checking…` : html` · <button class="link" title="Checks with ${address.split('@')[1]} (they will see your IP)" onClick=${() => store.verifyNip05Now(pubkey)}>verify</button>`}
  </small>`;
}

export function PersonInfo({ pubkey, messages }) {
  const p = profiles.value[pubkey] ?? {};
  return html`<div class="hero">
      <${Avatar} pubkey=${pubkey} size=${96} />
      <h3>${pubkey === me.value.pubkey ? 'Note to self' : store.displayName(pubkey)}</h3>
      <${Nip05Line} pubkey=${pubkey} />
    </div>
    ${p.about && html`<section><p class="about">${p.about}</p></section>`}
    <section>
      <${Field} label="DID" value=${nostr.did(pubkey)} onCopy=${() => copy(nostr.did(pubkey), 'DID copied')} />
      <${Field} label="npub" value=${nostr.shortKey(pubkey)} onCopy=${() => copy(nostr.npub(pubkey), 'npub copied')} />
      ${p.website && html`<${Field} label="Website" value=${p.website.replace(/^https:\/\//, '')} href=${p.website} />`}
    </section>
    <${DidIdentity} pubkey=${pubkey} />
    <${ChatToggles} chatKey=${pubkey} />
    ${pubkey !== me.value.pubkey &&
    html`<section class="actions">
      ${store.isBlocked(pubkey)
        ? html`<button onClick=${() => store.toggleBlock(pubkey).catch(fail('Unblock'))}>Unblock</button>`
        : html`<${ConfirmButton} label="⛔ Block" confirm="Tap again to block" onConfirm=${() => store.toggleBlock(pubkey).catch(fail('Block'))} />`}
      <${ConfirmButton} label="🗑 Delete chat" confirm="Tap again to delete this chat" onConfirm=${() => {
        store.deleteChat(pubkey);
        store.go('');
      }} />
    </section>`}
    <${SharedMedia} messages=${messages} allowed=${() => true} />`;
}

export function RoomInfo({ room, messages }) {
  const authors = [...new Set(messages.map((m) => m.pubkey))].sort((a, b) => store.displayName(a).localeCompare(store.displayName(b)));
  const link = `${location.origin}${location.pathname}#/room/${nostr.encodeRoomLink(room)}`;
  const joined = joinedRooms.value.some((r) => r.address === room.address);
  const host = (() => { try { return new URL(room.address).host; } catch { return ''; } })();
  const mayWrite = store.canWrite(room.address);
  return html`<div class="hero">
      <${RoomAvatar} room=${room} size=${96} />
      <h3>${room.name}</h3>
      <small class="muted">Solid chat on ${host} · ${authors.length} recent ${authors.length === 1 ? 'poster' : 'posters'}</small>
    </div>
    ${room.about && html`<section><p class="about">${room.about}</p></section>`}
    <section>
      <${Field} label="Invite link" value="Copy link" onCopy=${() => copy(link, 'Chat link copied')} />
      <${Field} label="Chat address" value=${room.address.replace(/^https?:\/\//, '')} href=${room.address} />
      ${room.owner && html`<${Field} label="Owner" value=${store.displayName(room.owner)} onClick=${() => openProfile(room.owner)} />`}
      <${Field} label="Your access" value=${mayWrite ? 'Post, edit and delete (write)' : 'Post only (append)'} />
    </section>
    ${me.value && html`<${ChatToggles} chatKey=${room.address} />`}
    <${SharedMedia} messages=${messages} allowed=${() => true} />
    ${joined && html`<section><button class="danger wide" onClick=${() => store.leaveRoom(room.address)}>Leave chat</button></section>`}
    <section>
      <h4>People here</h4>
      ${authors.map(
        (pk) => html`<div class="item member" key=${pk}>
          <button class="who-link link" onClick=${() => openProfile(pk)}><${Avatar} pubkey=${pk} size=${32} /></button>
          <button class="label who-link link" onClick=${() => openProfile(pk)}><b>${store.displayName(pk)}</b><small class="muted">${nostr.isWebId(pk) ? 'WebID' : nostr.shortKey(pk)}</small></button>
          ${pk === room.owner && html`<span class="badge owner">owner</span>`}
        </div>`,
      )}
    </section>`;
}

export function InfoPanel({ children }) {
  if (!infoOpen.value) return null;
  return html`<aside class="info">
    <header class="bar">
      <div class="title"><b>Info</b></div>
      <button class="link close" title="Close" onClick=${() => (infoOpen.value = false)}>✕</button>
    </header>
    <div class="info-body">${children}</div>
  </aside>`;
}
