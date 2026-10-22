// Solid: the only module that talks to pods. Signed HTTP (NIP-98), RDF reads, the Solid
// chat format (meeting:LongChat with YYYY/MM/DD/chat.ttl day files, solid.github.io/chat),
// N3 Patch writes and live updates over the solid-0.1 WebSocket protocol.
//
// Message identity: a message is its URI inside a day file. Its author is the foaf:maker
// IRI: `did:nostr:<hex>` for people signed in here (kept as the bare hex everywhere else
// in the app, so Nostr profiles and DMs line up), any other WebID as the IRI itself.
import { RDF_TYPE, XSD, iri, literal, objectsOf, parseRdf, resolveIri, subjectsOf, valueOf, writeIri, writeTerm, writeTriple } from './turtle.js';

export const NS = {
  meeting: 'http://www.w3.org/ns/pim/meeting#',
  wf: 'http://www.w3.org/2005/01/wf/flow#',
  sioc: 'http://rdfs.org/sioc/ns#',
  dct: 'http://purl.org/dc/terms/',
  dc: 'http://purl.org/dc/elements/1.1/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  schema: 'http://schema.org/',
  ldp: 'http://www.w3.org/ns/ldp#',
  solid: 'http://www.w3.org/ns/solid/terms#',
  vcard: 'http://www.w3.org/2006/vcard/ns#',
  pim: 'http://www.w3.org/ns/pim/space#',
  acl: 'http://www.w3.org/ns/auth/acl#',
};
const T = {
  LongChat: `${NS.meeting}LongChat`,
  message: `${NS.wf}message`,
  content: `${NS.sioc}content`,
  created: `${NS.dct}created`,
  modified: `${NS.dct}modified`,
  maker: `${NS.foaf}maker`,
  hasReply: `${NS.sioc}has_reply`,
  replyOf: `${NS.sioc}reply_of`,
  dateDeleted: `${NS.schema}dateDeleted`,
  ReactAction: `${NS.schema}ReactAction`,
  about: `${NS.schema}about`,
  agent: `${NS.schema}agent`,
  name: `${NS.schema}name`,
  title: `${NS.dc}title`,
  dctTitle: `${NS.dct}title`,
  image: `${NS.schema}image`,
  contains: `${NS.ldp}contains`,
  foafName: `${NS.foaf}name`,
  foafImg: `${NS.foaf}img`,
  depiction: `${NS.foaf}depiction`,
  vcardFn: `${NS.vcard}fn`,
  hasPhoto: `${NS.vcard}hasPhoto`,
  storage: `${NS.pim}storage`,
};

const HEX = /^[a-f0-9]{64}$/;
const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------- Identity ----------

// A chat author id: the hex pubkey for did:nostr makers, the WebID IRI otherwise.
export const authorId = (makerIri) => {
  const m = /^did:nostr:([a-f0-9]{64})$/.exec(makerIri ?? '');
  return m ? m[1] : makerIri;
};
export const makerIri = (id) => (HEX.test(id) ? `did:nostr:${id}` : id);
export const isWebId = (id) => /^https?:\/\//.test(id ?? '');

// ---------- Signed HTTP (NIP-98) ----------

const sha256 = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Authorization header value: a kind 27235 event over the URL, method and body hash.
export async function authHeader(signer, url, method, body) {
  const tags = [['u', url], ['method', method.toUpperCase()]];
  if (body !== undefined && body !== null) tags.push(['payload', await sha256(body)]);
  const event = await signer.sign({ kind: 27235, created_at: nowSeconds(), tags, content: '' });
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  return `Nostr ${btoa(String.fromCharCode(...bytes))}`;
}

export class HttpError extends Error {
  constructor(status, message, res) {
    super(message);
    this.status = status;
    this.res = res;
  }
}

async function failure(res, what) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      detail = JSON.parse(text).message ?? '';
    } catch {
      detail = text.slice(0, 120);
    }
  } catch {}
  const host = (() => { try { return new URL(res.url).host; } catch { return 'the pod'; } })();
  const why = res.status === 401 ? 'you need to sign in to that pod' : res.status === 403 ? `${host} does not allow this for your key` : res.status === 404 ? 'not found' : res.status === 412 ? 'the file changed underneath, try again' : detail || `${res.status}`;
  return new HttpError(res.status, `${what}: ${why}`, res);
}

// fetch with a NIP-98 Authorization header when a signer is given and the server asked
// for one (or `auth: 'always'`). Anonymous first keeps public reads unsigned: a signed
// request tells the pod who you are.
export async function request(url, { signer, method = 'GET', body, headers = {}, auth = 'ifNeeded', what = 'Request' } = {}) {
  const send = (signed) => fetch(url, {
    method,
    body,
    headers: { ...headers, ...(signed ? { Authorization: signed } : {}) },
    referrerPolicy: 'no-referrer',
    credentials: 'omit',
    cache: 'no-store',
  });
  let res = await send(signer && auth === 'always' ? await authHeader(signer, url, method, body) : null);
  if ((res.status === 401 || res.status === 403) && signer && auth === 'ifNeeded') res = await send(await authHeader(signer, url, method, body));
  if (!res.ok) throw await failure(res, what);
  return res;
}

// ---------- RDF reads ----------

const ACCEPT_RDF = 'text/turtle, application/ld+json;q=0.9, application/n-triples;q=0.8, text/n3;q=0.7';

// GET an RDF document as triples. A missing document is an empty one (`missing: true`).
export async function readGraph(url, { signer, etag } = {}) {
  // cache: 'no-store' keeps the browser's HTTP cache out of it: the client does its own
  // If-None-Match with the ETag it remembers, so a stale cached body can never be shown.
  const opts = { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' };
  const res = await fetch(url, { ...opts, headers: { Accept: ACCEPT_RDF, ...(etag ? { 'If-None-Match': etag } : {}) } })
    .then(async (r) => (r.status === 401 || r.status === 403) && signer ? fetch(url, { ...opts, headers: { Accept: ACCEPT_RDF, Authorization: await authHeader(signer, url, 'GET') } }) : r);
  if (res.status === 304) return { triples: null, etag, unchanged: true, wacAllow: parseWacAllow(res.headers.get('WAC-Allow')) };
  if (res.status === 404) return { triples: [], etag: null, missing: true, wacAllow: parseWacAllow(res.headers.get('WAC-Allow')) };
  if (!res.ok) throw await failure(res, 'Reading');
  const base = stripFragment(url);
  const triples = parseRdf(await res.text(), res.headers.get('Content-Type'), base);
  return { triples, etag: res.headers.get('ETag'), wacAllow: parseWacAllow(res.headers.get('WAC-Allow')), updatesVia: res.headers.get('Updates-Via') };
}

// What the signed-in key may do with a document: a signed HEAD, because an anonymous
// read's WAC-Allow describes the anonymous user, not us.
export async function permissions(signer, url) {
  const target = stripFragment(url);
  const res = await fetch(target, { method: 'HEAD', headers: { Authorization: await authHeader(signer, target, 'HEAD') }, referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
  return parseWacAllow(res.headers.get('WAC-Allow'));
}

// WAC-Allow: user="read append", public="read" -> { user: Set, public: Set }
export function parseWacAllow(header) {
  const out = { user: new Set(), public: new Set() };
  for (const m of (header ?? '').matchAll(/(user|public)\s*=\s*"([^"]*)"/g)) out[m[1]] = new Set(m[2].split(/\s+/).filter(Boolean));
  return out;
}

export const stripFragment = (url) => url.split('#')[0];
export const containerOf = (url) => stripFragment(url).replace(/[^/]*$/, '');

// ---------- Chat model ----------

// A chat address is the channel's IRI, normally <root>/index.ttl#this. Anything people
// paste (the folder, the index file, an app link) is normalised to that.
export function chatAddress(input) {
  let value = input.trim();
  if (!value) throw new Error('Paste a chat link.');
  const app = value.match(/#\/room\/(.+)$/);
  if (app) value = decodeURIComponent(app[1]);
  if (!/^https?:\/\//.test(value)) throw new Error('A chat lives at an https:// address on a pod.');
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Invalid chat link.');
  if (url.hash) return url.href;
  if (url.pathname.endsWith('/')) return `${url.href}index.ttl#this`;
  return `${url.href}#this`;
}

export const chatRoot = (address) => containerOf(address);

// The open room every new account starts with.
export const STARTER_ROOM = {
  address: 'https://melvincarvalho.com/public/chats/lobby/index.ttl#this',
  root: 'https://melvincarvalho.com/public/chats/lobby/',
  owner: 'https://melvincarvalho.com/#me',
  name: 'Lobby',
  picture: '',
  about: 'The open room of Solid Chat. Anyone can read and post; stored on melvincarvalho.com.',
};
export const chatLink = (address) => `${location.origin}${location.pathname}#/room/${encodeURIComponent(address)}`;

const dayPath = (seconds) => {
  const d = new Date(seconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/chat.ttl`;
};
export const dayUrl = (address, seconds = nowSeconds()) => `${chatRoot(address)}${dayPath(seconds)}`;

// Read the channel description from its index document.
export function parseChat(triples, address) {
  const s = address;
  const types = objectsOf(triples, s, RDF_TYPE).map((o) => o.value);
  if (!types.includes(T.LongChat) && !triples.some((t) => t.s === s)) throw new Error('No chat at that address.');
  const name = valueOf(triples, s, T.title) ?? valueOf(triples, s, T.dctTitle) ?? valueOf(triples, s, T.name) ?? '';
  const maker = valueOf(triples, s, T.maker) ?? valueOf(triples, s, `${NS.dc}author`) ?? valueOf(triples, s, `${NS.dct}creator`) ?? '';
  const image = valueOf(triples, s, T.image) ?? '';
  const created = parseDate(valueOf(triples, s, T.created));
  return {
    address,
    root: chatRoot(address),
    name: (name || decodeURIComponent(chatRoot(address).split('/').filter(Boolean).pop() ?? 'Chat')).slice(0, 100),
    owner: maker ? authorId(maker) : '',
    picture: /^https:\/\//.test(image) ? image : '',
    created,
    about: (valueOf(triples, s, `${NS.dct}description`) ?? valueOf(triples, s, `${NS.schema}description`) ?? '').slice(0, 2000),
  };
}

export function parseDate(value) {
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// Messages (and reactions) in one day file. Every message is one subject with
// sioc:content, dct:created and foaf:maker, linked from the channel with wf:message.
export function parseDay(triples, address) {
  const linked = new Set(objectsOf(triples, address, T.message).map((o) => o.value));
  const subjects = new Set([...linked, ...triples.filter((t) => t.p === T.content).map((t) => t.s)]);
  const messages = [];
  const reactions = [];
  const deleted = new Set(triples.filter((t) => t.p === T.dateDeleted).map((t) => t.s));
  for (const s of subjects) {
    if (s.startsWith('_:')) continue;
    const content = valueOf(triples, s, T.content);
    const created = parseDate(valueOf(triples, s, T.created));
    const maker = valueOf(triples, s, T.maker);
    if (content === undefined || !created || !maker) continue;
    const replyOf = valueOf(triples, s, T.replyOf) ?? subjectsOf(triples, T.hasReply, s)[0];
    const modified = parseDate(valueOf(triples, s, T.modified));
    messages.push({
      id: s,
      pubkey: authorId(maker),
      created_at: created,
      content,
      tags: [],
      kind: 9,
      reply: replyOf,
      edited: !!modified && modified > created,
      deleted: deleted.has(s),
      raw: triples.filter((t) => t.s === s || t.o.value === s),
    });
  }
  for (const s of subjectsOf(triples, RDF_TYPE, T.ReactAction)) {
    const target = valueOf(triples, s, T.about);
    const agent = valueOf(triples, s, T.agent);
    const emoji = valueOf(triples, s, T.name);
    if (target && agent && emoji) reactions.push({ id: s, pubkey: authorId(agent), target, emoji: [...emoji].slice(0, 8).join(''), raw: triples.filter((t) => t.s === s) });
  }
  return { messages, reactions };
}

// ---------- Writing ----------

const N3_HEAD = '@prefix solid: <http://www.w3.org/ns/solid/terms#>.\n';
const inserts = (triples) => `${N3_HEAD}_:p a solid:InsertDeletePatch; solid:inserts {\n${triples.map(writeTriple).join('\n')}\n}.\n`;
const replace = (remove, add) => `${N3_HEAD}_:p a solid:InsertDeletePatch;\n  solid:deletes {\n${remove.map(writeTriple).join('\n')}\n  }${add.length ? `;\n  solid:inserts {\n${add.map(writeTriple).join('\n')}\n  }` : ''}.\n`;
const dateTime = (seconds) => literal(new Date(seconds * 1000).toISOString(), `${XSD}dateTime`);

export function newMessageId(address, seconds = nowSeconds()) {
  const rand = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${dayUrl(address, seconds)}#m${seconds.toString(36)}${rand}`;
}

// The triples one new message adds (also what a delete removes).
export function messageTriples(address, message) {
  const s = message.id;
  const list = [
    { s: address, p: T.message, o: iri(s) },
    { s, p: T.created, o: dateTime(message.created_at) },
    { s, p: T.content, o: literal(message.content) },
    { s, p: T.maker, o: iri(makerIri(message.pubkey)) },
  ];
  if (message.reply) list.push({ s: message.reply, p: T.hasReply, o: iri(s) }, { s, p: T.replyOf, o: iri(message.reply) });
  return list;
}

export const appendPatch = (address, message) => inserts(messageTriples(address, message));

export function editPatch(message, text, seconds = nowSeconds()) {
  const remove = [{ s: message.id, p: T.content, o: literal(message.content) }];
  const add = [{ s: message.id, p: T.content, o: literal(text) }];
  const old = message.raw?.find((t) => t.p === T.modified);
  if (old) remove.push(old);
  add.push({ s: message.id, p: T.modified, o: dateTime(seconds) });
  return replace(remove, add);
}

// Remove every triple the message carries (readers of the spec's dateDeleted form also
// drop a message whose content is gone).
export const deletePatch = (message) => replace(message.raw ?? [], []);

export function reactionTriples(message, reaction) {
  const s = reaction.id;
  return [
    { s, p: RDF_TYPE, o: iri(T.ReactAction) },
    { s, p: T.about, o: iri(message.id) },
    { s, p: T.agent, o: iri(makerIri(reaction.pubkey)) },
    { s, p: T.name, o: literal(reaction.emoji) },
    { s, p: T.created, o: dateTime(reaction.created_at) },
  ];
}
export const reactionPatch = (message, reaction) => inserts(reactionTriples(message, reaction));
export const unreactPatch = (reaction) => replace(reaction.raw ?? [], []);

export function newReactionId(message, seconds = nowSeconds()) {
  const rand = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Reactions live in the day file of the message they are about.
  return `${stripFragment(message.id)}#r${seconds.toString(36)}${rand}`;
}

// PATCH a document. Servers create the document (and its folders) when it is missing.
// Patches to the same document from this client go one at a time, in order.
const patchQueues = new Map(); // url -> tail promise
export function patch(signer, url, body) {
  if (!signer) return Promise.reject(new Error('Sign in to post.'));
  const target = stripFragment(url);
  const run = () => request(target, { signer, method: 'PATCH', body, headers: { 'Content-Type': 'text/n3' }, auth: 'always', what: 'Posting' }).then(() => {});
  const tail = (patchQueues.get(target) ?? Promise.resolve()).then(run, run);
  patchQueues.set(target, tail);
  tail.finally(() => patchQueues.get(target) === tail && patchQueues.delete(target)).catch(() => {});
  return tail;
}

// ---------- Creating a chat ----------

const TTL_HEAD = `@prefix meeting: <${NS.meeting}>.\n@prefix dc: <${NS.dc}>.\n@prefix dct: <${NS.dct}>.\n@prefix foaf: <${NS.foaf}>.\n@prefix xsd: <${XSD}>.\n`;

export function chatIndexTurtle({ name, owner, created = nowSeconds() }) {
  return `${TTL_HEAD}\n<#this> a meeting:LongChat;\n    dc:title ${writeTerm(literal(name))};\n    dct:created ${writeTerm(dateTime(created))};\n    foaf:maker ${writeIri(makerIri(owner))}.\n`;
}

// Owner: everything. Everyone else: read and append (post), nothing more. Written as
// JSON-LD (JSS insists on it for ACLs; other Solid servers accept any RDF syntax).
export function chatAcl(owner, { open = true } = {}) {
  const auth = (id, who, modes) => ({ '@id': id, '@type': 'acl:Authorization', ...who, 'acl:accessTo': { '@id': './' }, 'acl:default': { '@id': './' }, 'acl:mode': modes.map((m) => ({ '@id': `acl:${m}` })) });
  const graph = [auth('#owner', { 'acl:agent': { '@id': makerIri(owner) } }, ['Read', 'Write', 'Control'])];
  if (open) graph.push(auth('#public', { 'acl:agentClass': { '@id': 'foaf:Agent' } }, ['Read', 'Append']));
  return { '@context': { acl: NS.acl, foaf: NS.foaf }, '@graph': graph };
}

const slugOf = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'chat';

// Create <pod>/<slug>/ with index.ttl and .acl; returns the chat address.
export async function createChat(signer, podContainer, { name, open = true }) {
  const base = podContainer.endsWith('/') ? podContainer : `${podContainer}/`;
  const root = `${base}${slugOf(name)}-${Date.now().toString(36)}/`;
  const put = (url, body, type) => request(url, { signer, method: 'PUT', body, headers: { 'Content-Type': type }, auth: 'always', what: 'Creating the chat' });
  await put(`${root}index.ttl`, chatIndexTurtle({ name, owner: signer.pubkey }), 'text/turtle');
  await put(`${root}.acl`, JSON.stringify(chatAcl(signer.pubkey, { open }), null, 2), 'application/ld+json');
  return `${root}index.ttl#this`;
}

// ---------- History: which day files exist ----------

// Children of a container (ldp:contains), as absolute URLs.
export async function listContainer(url, signer) {
  const { triples, missing } = await readGraph(url, { signer });
  if (missing) return [];
  return objectsOf(triples, url, T.contains).map((o) => resolveIri(o.value, url));
}

// Every day file of a chat, newest first, by walking YYYY/ -> MM/ -> DD/.
export async function listDays(address, signer) {
  const root = chatRoot(address);
  const numeric = (list, width) => list.filter((u) => new RegExp(`/\\d{${width}}/$`).test(u)).sort().reverse();
  const days = [];
  for (const year of numeric(await listContainer(root, signer), 4))
    for (const month of numeric(await listContainer(year, signer), 2))
      for (const day of numeric(await listContainer(month, signer), 2)) days.push(`${day}chat.ttl`);
  return days;
}

// ---------- People ----------

// Name and picture from a WebID profile document.
export async function readWebIdProfile(webId) {
  const { triples } = await readGraph(stripFragment(webId));
  const s = webId;
  const name = valueOf(triples, s, T.foafName) ?? valueOf(triples, s, T.vcardFn) ?? valueOf(triples, s, T.name) ?? '';
  const photo = valueOf(triples, s, T.foafImg) ?? valueOf(triples, s, T.hasPhoto) ?? valueOf(triples, s, T.depiction) ?? valueOf(triples, s, T.image) ?? '';
  const storage = objectsOf(triples, s, T.storage).map((o) => resolveIri(o.value, webId));
  return { name: name.slice(0, 80), picture: /^https:\/\//.test(photo) ? resolveIri(photo, webId) : '', storage };
}

// ---------- Live updates (solid-0.1 WebSockets) ----------
// One socket per origin, discovered from the Updates-Via header; subscriptions are
// multiplexed and restored after a reconnect.

const sockets = new Map(); // origin -> { ws, subs: Map<url, Set<fn>>, url, timer, attempts }

async function updatesViaFor(url) {
  const res = await fetch(stripFragment(url), { method: 'HEAD', referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' }).catch(() => null);
  const header = res?.headers.get('Updates-Via');
  // A pod behind a TLS proxy may advertise ws://; from an https page only wss:// can connect.
  if (header) return location.protocol === 'https:' ? header.replace(/^ws:\/\//, 'wss://') : header;
  // Common default when the header is missing on an error response.
  const u = new URL(url);
  return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/.notifications`;
}

function connect(entry) {
  const ws = new WebSocket(entry.url);
  entry.ws = ws;
  ws.onopen = () => {
    entry.attempts = 0;
    for (const url of entry.subs.keys()) ws.send(`sub ${url}`);
  };
  ws.onmessage = (e) => {
    const text = String(e.data);
    if (!text.startsWith('pub ')) return;
    const url = text.slice(4).trim();
    for (const fn of entry.subs.get(url) ?? []) fn(url);
  };
  ws.onclose = () => {
    entry.ws = null;
    if (!entry.subs.size) return;
    entry.attempts = Math.min((entry.attempts ?? 0) + 1, 6);
    entry.timer = setTimeout(() => connect(entry), 1000 * 2 ** entry.attempts);
  };
  ws.onerror = () => {};
}

// Call `onChange(url)` whenever the document changes; returns { close() }.
export function watch(url, onChange) {
  const target = stripFragment(url);
  const origin = new URL(target).origin;
  let closed = false;
  let entry = sockets.get(origin);
  const subscribe = () => {
    if (closed) return;
    const fns = entry.subs.get(target) ?? new Set();
    fns.add(onChange);
    entry.subs.set(target, fns);
    if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(`sub ${target}`);
    else if (!entry.ws && !entry.timer) connect(entry);
  };
  if (entry) subscribe();
  else {
    entry = { ws: null, subs: new Map(), url: '', timer: null, attempts: 0 };
    sockets.set(origin, entry);
    updatesViaFor(target).then((wsUrl) => {
      entry.url = wsUrl;
      subscribe();
    });
  }
  return {
    close() {
      closed = true;
      const fns = entry.subs.get(target);
      fns?.delete(onChange);
      if (fns && !fns.size) {
        entry.subs.delete(target);
        if (entry.ws?.readyState === WebSocket.OPEN) entry.ws.send(`unsub ${target}`);
      }
      if (!entry.subs.size) {
        clearTimeout(entry.timer);
        entry.timer = null;
        entry.ws?.close();
        entry.ws = null;
        sockets.delete(origin);
      }
    },
  };
}

// True when a live socket is open (for the connection banner).
export const live = () => [...sockets.values()].some((e) => e.ws?.readyState === WebSocket.OPEN);

