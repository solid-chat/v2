// New message / open or create a chat.
import { useState, useEffect } from 'preact/hooks';
import * as nostr from '../nostr.js';
import * as store from '../store.js';
import { Avatar, html, useAction } from './common.js';
const { me, profiles } = store;

// Find someone to message: paste an identity, search nostr.social, or pick from your follows.
function PeopleFinder() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ q: '', people: [], error: '' });
  const [follows, setFollows] = useState(null);
  const open = useAction();
  const q = query.trim();
  const direct = nostr.decodePubkey(q);
  useEffect(() => {
    store.followsOf(me.value.pubkey).then(setFollows, () => setFollows([]));
  }, []);
  useEffect(() => {
    if (q.length < 2 || direct || q.includes('@')) return setResults({ q: '', people: [], error: '' });
    const timer = setTimeout(() => {
      nostr.searchDirectory(q, 20).then(
        (people) => {
          store.rememberProfiles(people);
          setResults({ q, people, error: '' });
        },
        (e) => setResults({ q, people: [], error: e.message }),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);
  const go = (pk) => store.go(`#/dm/${nostr.did(pk)}`);
  const lower = q.toLowerCase();
  const followRows = (follows ?? []).filter((pk) => !lower || store.displayName(pk).toLowerCase().includes(lower)).slice(0, 60);
  useEffect(() => follows && store.requestProfiles(follows.slice(0, 60)), [follows]);
  const row = (pk, extra) => html`<button class="item person" onClick=${() => go(pk)}>
    <${Avatar} pubkey=${pk} />
    <span class="label">
      <b>${store.displayName(pk)}</b>
      <small>${extra ?? (profiles.value[pk]?.nip05 || nostr.shortKey(pk))}</small>
    </span>
  </button>`;
  return html`<div class="card people">
    <h3>New message</h3>
    <form onSubmit=${(e) => {
      e.preventDefault();
      open.run(async () => go((await nostr.resolvePubkey(q)).pubkey));
    }}>
      <input autofocus placeholder="Search people, or paste did:nostr / nostr.social link / name@domain" value=${query} onInput=${(e) => setQuery(e.target.value)} />
    </form>
    ${open.error && html`<p class="error">${open.error}</p>`}
    <div class="people-list">
      ${direct && row(direct, nostr.did(direct))}
      ${!direct && q.includes('@') && html`<button class="item person" onClick=${() => open.run(async () => go((await nostr.resolvePubkey(q)).pubkey))}>
        <span class="avatar room">@</span><span class="label"><b>Look up ${q}</b><small>NIP-05 address</small></span></button>`}
      ${results.q === q &&
      results.people.map((p) => row(p.pubkey, `${p.nip05 || nostr.shortKey(p.pubkey)} · ${p.followers} followers`))}
      ${results.q === q && !results.people.length && !results.error && html`<p class="muted small">No people found on nostr.social.</p>`}
      ${results.error && html`<p class="muted small">Search unavailable: ${results.error}</p>`}
      ${!direct && followRows.length > 0 && html`<h4>People you follow</h4>${followRows.map((pk) => row(pk))}`}
      ${follows === null && html`<p class="muted small">Loading people you follow…</p>`}
    </div>
    <p class="muted small">Encrypted end to end (NIP-17). Search by nostr.social · results are signature-checked.</p>
  </div>`;
}

export function NewThing() {
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [open, setOpen] = useState(true);
  const join = useAction();
  const create = useAction();
  const pod = store.podUrl.value;
  return html`<section class="main scroll">
    <header class="bar"><a class="back" href="#">‹</a><div class="title"><b>New</b></div></header>
    <div class="forms">
      <${PeopleFinder} />
      <form class="card" onSubmit=${(e) => {
        e.preventDefault();
        join.run(async () => {
          const pointer = nostr.decodeRoomLink(link);
          store.go(`#/room/${nostr.encodeRoomLink(pointer)}`);
        });
      }}>
        <h3>Open a chat</h3>
        <input placeholder="Chat link, or the chat's address on a pod (https://…/index.ttl#this)" value=${link} onInput=${(e) => setLink(e.target.value)} />
        <p class="muted small">Any Solid chat works: a link from this app, or the folder or index of a chat on someone's pod.</p>
        ${join.error && html`<p class="error">${join.error}</p>`}
        <button class="primary" disabled=${join.busy}>Open chat</button>
      </form>
      <form class="card" onSubmit=${(e) => {
        e.preventDefault();
        create.run(async () => {
          const room = await store.createRoom({ name, open });
          store.go(`#/room/${nostr.encodeRoomLink(room)}`);
        });
      }}>
        <h3>Create a chat on your pod</h3>
        ${pod
          ? html`<p class="muted small">A new folder inside <span class="mono">${pod.replace(/^https?:\/\//, '')}</span> (change it in <a href="#/settings">Settings</a>).</p>`
          : html`<p class="muted small">Set your pod folder in <a href="#/settings">Settings</a> first: chats are folders on a Solid pod where your key may write.</p>`}
        <input placeholder="Name" maxlength="100" value=${name} onInput=${(e) => setName(e.target.value)} />
        <label class="check"><input type="checkbox" checked=${open} onChange=${(e) => setOpen(e.target.checked)} /> Anyone with the link can read and post</label>
        ${!open && html`<p class="muted small">Only you can read and post until you change the folder's permissions (.acl) on the pod.</p>`}
        ${create.error && html`<p class="error">${create.error}</p>`}
        <button class="primary" disabled=${create.busy || !pod}>${create.busy ? 'Creating…' : 'Create chat'}</button>
      </form>
    </div>
  </section>`;
}
