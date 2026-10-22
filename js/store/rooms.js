// Chat rooms: Solid chats (meeting:LongChat) on pods. Opening a room reads its index and
// recent day files, watches today's file for changes, and pages back through older
// days on demand. Posting is an N3 Patch append; reactions, edits and deletions are
// patches too (edits and deletions need Write on the pod, which a public room's guests
// do not have).
import { signal } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as solid from '../solid.js';
import * as db from '../db.js';
import { go, joinedRooms, me, notify, reactions, roomState, storage } from './core.js';
import { emitIncoming, isHidden } from './prefs.js';
import { isBlocked, requestProfiles } from './people.js';
import { addReactions, applyDeletions, isDeleted, knownIds, setStatus, track } from './messages.js';

const watchers = new Map(); // address -> { close }
const dayCache = new Map(); // dayUrl -> { etag, ids: Set }
const dayLists = new Map(); // address -> [dayUrl] newest first (history walk)
const pending = new Set(); // message ids being posted (not yet on the pod)

export function load(signer) {
  const saved = storage.get(`chat:rooms:${signer.pubkey}`, null);
  // A first run starts in the open Lobby; leaving it is remembered like any other room.
  joinedRooms.value = saved ?? [{ ...solid.STARTER_ROOM }];
}

export function reset() {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  dayCache.clear();
  dayLists.clear();
  pending.clear();
  clearTimeout(rolloverTimer);
}

export function resetSignals() {
  roomState.value = {};
  joinedRooms.value = [];
}

export function setRoom(address, patch) {
  const current = roomState.value[address] ?? { messages: [] };
  roomState.value = { ...roomState.value, [address]: { ...current, ...patch } };
}

// Whether this account may edit and delete in the room (acl:Write), from WAC-Allow.
export const canWrite = (address) => !!roomState.value[address]?.canWrite;

// ---------- Messages ----------

const roomSaves = new Map();
let roomSaveTimer;
function queueRoomSave(address, messages) {
  roomSaves.set(address, [...(roomSaves.get(address) ?? []), ...messages]);
  clearTimeout(roomSaveTimer);
  roomSaveTimer = setTimeout(() => {
    for (const [room, list] of roomSaves) db.saveRoomMessages(room, list.map(({ raw: _, ...m }) => m)).catch(() => {});
    roomSaves.clear();
  }, 500);
}

const byTime = (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1);

export function addRoomMessages(address, list, { fromCache = false } = {}) {
  list = list.filter((m) => !isBlocked(m.pubkey) && !isDeleted(m.id, m.pubkey) && !isHidden(m.id) && !m.deleted && m.content.length <= 20000);
  const current = roomState.value[address]?.messages ?? [];
  const byId = new Map(current.map((m) => [m.id, m]));
  const fresh = [];
  const changed = [];
  for (const m of list) {
    const old = byId.get(m.id);
    if (!old) fresh.push(m);
    else if (!fromCache && (old.content !== m.content || !!old.edited !== !!m.edited || (m.raw && !old.raw)))
      changed.push({ ...old, content: m.content, edited: m.edited, reply: m.reply ?? old.reply, raw: m.raw ?? old.raw });
  }
  if (!fresh.length && !changed.length) return;
  const replaced = new Map(changed.map((m) => [m.id, m]));
  setRoom(address, { messages: [...current.map((m) => replaced.get(m.id) ?? m), ...fresh].sort(byTime) });
  if (!fromCache) queueRoomSave(address, [...fresh, ...changed]);
  requestProfiles(nostr.uniq(fresh.map((m) => m.pubkey)));
  const room = roomState.value[address]?.room;
  if (room && !fromCache && joinedRooms.value.some((r) => r.address === address)) for (const m of fresh) emitIncoming({ room }, m);
}

// Messages that vanished from a day file were deleted on the pod.
function dropMissing(address, dayUrl, present) {
  const state = roomState.value[address];
  if (!state) return;
  const gone = state.messages.filter((m) => m.id.startsWith(`${dayUrl}#`) && !present.has(m.id) && !pending.has(m.id));
  if (!gone.length) return;
  setRoom(address, { messages: state.messages.filter((m) => !gone.includes(m)) });
  db.deleteRoomMessages(gone.map((m) => m.id)).catch(() => {});
}

function saveJoined(list) {
  joinedRooms.value = list;
  storage.set(`chat:rooms:${me.value.pubkey}`, list);
}

const roomEntry = (room) => ({ address: room.address, root: room.root, owner: room.owner, name: room.name, picture: room.picture, about: room.about });

function remember(room) {
  saveJoined([roomEntry(room), ...joinedRooms.value.filter((r) => r.address !== room.address)]);
}

function applyWac(address, wacAllow) {
  if (!wacAllow || !me.value) return;
  const user = new Set([...wacAllow.user, ...wacAllow.public]);
  const current = roomState.value[address] ?? {};
  setRoom(address, { canWrite: !!current.canWrite || user.has('write'), canAppend: !!current.canAppend || user.has('append') || user.has('write') });
}

// Read one day file into the room (messages and reactions), tracking the ETag.
async function readDay(address, dayUrl, { silent = false } = {}) {
  const cached = dayCache.get(dayUrl);
  const { triples, missing, unchanged, etag, wacAllow } = await solid.readGraph(dayUrl, { signer: me.value, etag: cached?.etag });
  if (unchanged) return { count: cached?.ids.size ?? 0, missing: false };
  applyWac(address, wacAllow);
  if (missing) {
    dayCache.set(dayUrl, { etag: null, ids: new Set() });
    return { count: 0, missing: true };
  }
  const { messages, reactions: found } = solid.parseDay(triples, address);
  dayCache.set(dayUrl, { etag, ids: new Set(messages.map((m) => m.id)) });
  addRoomMessages(address, messages, { fromCache: silent });
  dropMissing(address, dayUrl, new Set(messages.map((m) => m.id)));
  addReactions(found);
  // Our own posts that are now on the pod are no longer "sending".
  for (const m of messages) if (m.pubkey === me.value?.pubkey) setStatus(m.id, null);
  return { count: messages.length, missing: false };
}

export async function openRoom(pointer) {
  const { address } = pointer;
  if (watchers.has(address) || roomState.value[address]?.loading) return;
  if (!me.value) return;
  const owner = me.value;
  setRoom(address, { loading: true, error: '' });
  const remembered = joinedRooms.value.find((r) => r.address === address);
  if (remembered && !roomState.value[address]?.room) setRoom(address, { room: { ...remembered, trusted: [], blocked: [] } });
  db.loadRoomMessages(address)
    .then((cached) => me.value === owner && addRoomMessages(address, cached, { fromCache: true }))
    .catch(() => {});
  let room;
  let indexMessages = [];
  try {
    const { triples, missing, wacAllow } = await solid.readGraph(solid.stripFragment(address), { signer: owner });
    if (me.value !== owner) return;
    if (missing) throw new Error('No chat at that address.');
    room = { ...solid.parseChat(triples, address), trusted: [], blocked: [] };
    // Chats that keep their messages in the index document itself (the earlier Solid
    // Chat app, ShortChat) are shown too; new posts still go to day files.
    const inIndex = solid.parseDay(triples, address);
    indexMessages = inIndex.messages;
    addReactions(inIndex.reactions);
    applyWac(address, wacAllow);
    // Our own rights (the anonymous read's WAC-Allow describes the public).
    solid.permissions(owner, solid.dayUrl(address)).then((w) => me.value === owner && applyWac(address, w)).catch(() => {});
  } catch (e) {
    if (me.value !== owner) return;
    room = roomState.value[address]?.room;
    if (!room) return setRoom(address, { loading: false, error: e.message });
    setRoom(address, { stale: e.message });
  }
  setRoom(address, { room, loading: false });
  if (room.owner) requestProfiles([room.owner]);
  if (indexMessages.length) addRoomMessages(address, indexMessages, { fromCache: true });
  if (joinedRooms.value.some((r) => r.address === address)) saveJoined(joinedRooms.value.map((r) => (r.address === address ? roomEntry(room) : r)));
  // Today, then the most recent earlier days until a screenful is loaded.
  const today = solid.dayUrl(address);
  try {
    await readDay(address, today);
  } catch (e) {
    if (me.value !== owner) return;
    setRoom(address, { stale: e.message });
  }
  if (me.value !== owner) return;
  watchDay(address, today);
  scheduleRollover();
  if ((roomState.value[address]?.messages.length ?? 0) < 30) loadOlderRoomMessages(address, 30).catch(() => {});
}

function watchDay(address, dayUrl) {
  watchers.get(address)?.close();
  let refreshing = null;
  const refresh = () => {
    refreshing ??= readDay(address, dayUrl).catch(() => {}).finally(() => (refreshing = null));
  };
  const w = solid.watch(dayUrl, refresh);
  // Live sockets can miss an event (reconnects); a slow poll backs them up.
  const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 45000);
  const onVisible = () => document.visibilityState === 'visible' && refresh();
  document.addEventListener('visibilitychange', onVisible);
  watchers.set(address, {
    close() {
      w.close();
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
    },
  });
}

// At UTC midnight every open room moves to a new day file.
let rolloverTimer;
function scheduleRollover() {
  clearTimeout(rolloverTimer);
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  rolloverTimer = setTimeout(() => {
    for (const address of watchers.keys()) {
      const today = solid.dayUrl(address);
      watchDay(address, today);
      readDay(address, today).catch(() => {});
    }
    scheduleRollover();
  }, next - now.getTime() + 1000);
}

// Page back through earlier day files until `want` more messages are loaded or history ends.
export async function loadOlderRoomMessages(address, want = 50) {
  const state = roomState.value[address];
  if (!state?.room || state.exhausted) return;
  if (!dayLists.has(address)) {
    try {
      dayLists.set(address, await solid.listDays(address, me.value));
    } catch {
      dayLists.set(address, []);
    }
  }
  const days = dayLists.get(address);
  let got = 0;
  for (const day of days) {
    if (dayCache.has(day)) continue;
    try {
      got += (await readDay(address, day, { silent: true })).count;
    } catch {}
    if (got >= want) break;
  }
  if (!days.some((d) => !dayCache.has(d))) setRoom(address, { exhausted: true });
}

export async function loadUntil(address, id, maxPages = 10) {
  const has = () => roomState.value[address]?.messages.some((m) => m.id === id);
  for (let i = 0; i < maxPages && !has() && !roomState.value[address]?.exhausted; i++) await loadOlderRoomMessages(address, 50);
  return has();
}

export const quotes = signal({}); // id -> message | null, for replies to messages not loaded
export function fetchQuote(address, id) {
  if (quotes.value[id] !== undefined) return;
  quotes.value = { ...quotes.value, [id]: null };
  solid.readGraph(solid.stripFragment(id), { signer: me.value })
    .then(({ triples }) => {
      const found = triples && solid.parseDay(triples, address).messages.find((m) => m.id === id);
      if (found) quotes.value = { ...quotes.value, [id]: found };
    })
    .catch(() => {});
}

export function dropRoomMessage(address, id) {
  const state = roomState.value[address];
  if (state) setRoom(address, { messages: state.messages.filter((m) => m.id !== id) });
  db.deleteRoomMessages([id]).catch(() => {});
}

export function joinRoom(room) {
  remember(room);
}

export function leaveRoom(address) {
  saveJoined(joinedRooms.value.filter((r) => r.address !== address));
  watchers.get(address)?.close();
  watchers.delete(address);
  const next = { ...roomState.value };
  delete next[address];
  roomState.value = next;
  go('');
}

// ---------- Posting ----------

export async function sendRoomMessage(address, text, reply, extraTags = []) {
  const signer = me.value;
  const state = roomState.value[address];
  if (!state?.room) throw new Error('Room not loaded.');
  const created_at = nostr.now();
  const message = {
    id: solid.newMessageId(address, created_at),
    pubkey: signer.pubkey,
    created_at,
    content: text,
    tags: extraTags,
    kind: 9,
    reply: reply ? reply.id : undefined,
  };
  message.raw = solid.messageTriples(address, message);
  pending.add(message.id);
  addRoomMessages(address, [message]);
  const publish = () =>
    solid.patch(signer, solid.stripFragment(message.id), solid.appendPatch(address, message)).finally(() => pending.delete(message.id));
  track(message.id, publish(), publish);
}

export async function editRoomMessage(address, message, text) {
  const signer = me.value;
  if (message.pubkey !== signer.pubkey) throw new Error('You can only edit your own messages.');
  if (!canWrite(address)) throw new Error('This pod only lets you add messages here, not change them.');
  const current = roomState.value[address]?.messages.find((m) => m.id === message.id) ?? message;
  const raw = current.raw ?? solid.messageTriples(address, current);
  const next = { ...current, content: text, edited: true };
  setRoom(address, { messages: roomState.value[address].messages.map((m) => (m.id === message.id ? next : m)) });
  setStatus(message.id, 'sending');
  try {
    await solid.patch(signer, solid.stripFragment(message.id), solid.editPatch({ ...current, raw }, text));
    setStatus(message.id, null);
    queueRoomSave(address, [next]);
  } catch (e) {
    setStatus(message.id, null);
    setRoom(address, { messages: roomState.value[address].messages.map((m) => (m.id === message.id ? current : m)) });
    throw new Error(`Edit failed: ${e.message}`);
  }
}

export async function deleteRoomMessage(address, message) {
  const signer = me.value;
  if (message.pubkey !== signer.pubkey) throw new Error('You can only delete your own messages.');
  if (!canWrite(address)) throw new Error('This pod only lets you add messages here, not remove them.');
  const current = roomState.value[address]?.messages.find((m) => m.id === message.id) ?? message;
  const raw = current.raw ?? solid.messageTriples(address, current);
  dropRoomMessage(address, message.id);
  try {
    await solid.patch(signer, solid.stripFragment(message.id), solid.deletePatch({ ...current, raw }));
  } catch (e) {
    addRoomMessages(address, [current]);
    notify(`Delete failed: ${e.message}`);
  }
}

// Reactions are schema:ReactAction nodes in the day file of the message. Adding one is an
// append; removing your own needs Write.
export async function toggleRoomReaction(address, message, emoji) {
  const signer = me.value;
  const mine = knownIds(message)
    .flatMap((id) => (reactions.value[id] ?? []).map((r) => ({ ...r, target: id })))
    .filter((r) => r.pubkey === signer.pubkey && r.emoji === emoji);
  if (mine.length) {
    if (!canWrite(address)) throw new Error('This pod only lets you add reactions here, not remove them.');
    if (mine.some((r) => !r.raw?.length)) throw new Error('Reload the chat before removing this reaction.');
    applyDeletions(mine.map((r) => r.id), signer.pubkey);
    try {
      for (const r of mine) await solid.patch(signer, solid.stripFragment(r.id), solid.unreactPatch(r));
    } catch (e) {
      addReactions(mine);
      throw e;
    }
    return;
  }
  const created_at = nostr.now();
  const reaction = { id: solid.newReactionId(message, created_at), pubkey: signer.pubkey, target: message.id, emoji, created_at };
  reaction.raw = solid.reactionTriples(message, reaction);
  addReactions([reaction]);
  try {
    await solid.patch(signer, solid.stripFragment(reaction.id), solid.reactionPatch(message, reaction));
  } catch (e) {
    applyDeletions([reaction.id], signer.pubkey);
    throw e;
  }
}

// ---------- Creating ----------

export const podUrl = signal(storage.get('chat:pod', ''));
export function setPodUrl(value) {
  const v = value.trim();
  if (v) {
    let url;
    try {
      url = new URL(v);
    } catch {
      throw new Error('Enter the https:// address of a folder on your pod.');
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error('Enter the https:// address of a folder on your pod.');
  }
  podUrl.value = v ? (v.endsWith('/') ? v : `${v}/`) : '';
  storage.set('chat:pod', podUrl.value || undefined);
}

export async function createRoom({ name, open = true }) {
  if (!podUrl.value) throw new Error('Set your pod folder in Settings first.');
  if (!name.trim()) throw new Error('Give the chat a name.');
  const address = await solid.createChat(me.value, podUrl.value, { name: name.trim().slice(0, 100), open });
  const room = { address, root: solid.chatRoot(address), owner: me.value.pubkey, name: name.trim().slice(0, 100), picture: '', about: '', trusted: [], blocked: [] };
  setRoom(address, { room, messages: [], canWrite: true, canAppend: true });
  remember(room);
  return room;
}
