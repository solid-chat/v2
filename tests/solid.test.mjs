import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from '../vendor/nostr-tools.mjs';
import * as solid from '../js/solid.js';
import { parseJsonLd, parseTurtle } from '../js/turtle.js';

const sk = generateSecretKey();
const me = getPublicKey(sk);
const signer = { pubkey: me, sign: async (t) => finalizeEvent(t, sk) };
const address = 'https://pod.example/alice/chats/lobby/index.ttl#this';

test('chat addresses are normalised from folders, index files and app links', () => {
  assert.equal(solid.chatAddress('https://pod.example/alice/chats/lobby/'), address);
  assert.equal(solid.chatAddress('https://pod.example/alice/chats/lobby/index.ttl'), 'https://pod.example/alice/chats/lobby/index.ttl');
  assert.equal(solid.chatAddress(address), address);
  assert.equal(solid.chatAddress(`https://solid-chat.com/v2/#/room/${encodeURIComponent(address)}`), address);
  assert.throws(() => solid.chatAddress('34550:abc:slug'), /https/);
  assert.throws(() => solid.chatAddress('https://u:p@pod.example/x/'), /Invalid/);
  assert.equal(solid.chatRoot(address), 'https://pod.example/alice/chats/lobby/');
  assert.equal(solid.dayUrl(address, Date.UTC(2026, 9, 22, 23, 59, 59) / 1000), 'https://pod.example/alice/chats/lobby/2026/10/22/chat.ttl');
});

test('findChannel settles a document address on the channel inside it', () => {
  const doc = 'https://pod.example/x/index.ttl';
  const typed = parseTurtle(`<#this> a <http://www.w3.org/ns/pim/meeting#LongChat> .`, doc);
  assert.equal(solid.findChannel(typed, doc), `${doc}#this`);
  assert.equal(solid.findChannel(typed, `${doc}#this`), `${doc}#this`);
  const bare = parseTurtle(`<> a <http://www.w3.org/ns/pim/meeting#LongChat>; <http://www.w3.org/2005/01/wf/flow#message> <#m1> .`, doc);
  assert.equal(solid.findChannel(bare, `${doc}#this`), doc);
  const linkOnly = parseTurtle(`<> <http://www.w3.org/2005/01/wf/flow#message> <#m1> . <#m1> <http://rdfs.org/sioc/ns#content> "x" .`, doc);
  assert.equal(solid.findChannel(linkOnly, doc), doc);
});

test('author ids: did:nostr makers become hex, WebIDs stay IRIs', () => {
  assert.equal(solid.authorId(`did:nostr:${me}`), me);
  assert.equal(solid.authorId('https://alice.pod/profile/card#me'), 'https://alice.pod/profile/card#me');
  assert.equal(solid.makerIri(me), `did:nostr:${me}`);
  assert.equal(solid.makerIri('https://alice.pod/profile/card#me'), 'https://alice.pod/profile/card#me');
  assert.ok(solid.isWebId('https://alice.pod/profile/card#me') && !solid.isWebId(me));
});

test('NIP-98 header: a signed kind 27235 over url, method and body hash', async () => {
  const header = await solid.authHeader(signer, 'https://pod.example/x/chat.ttl', 'patch', 'body');
  assert.match(header, /^Nostr [A-Za-z0-9+/=]+$/);
  const event = JSON.parse(Buffer.from(header.slice(6), 'base64').toString());
  assert.ok(verifyEvent(event));
  assert.equal(event.kind, 27235);
  assert.equal(event.pubkey, me);
  assert.deepEqual(event.tags.slice(0, 2), [['u', 'https://pod.example/x/chat.ttl'], ['method', 'PATCH']]);
  assert.equal(event.tags[2][0], 'payload');
  assert.equal(event.tags[2][1].length, 64);
});

test('a new message appends spec triples that parse back into the same message', () => {
  const message = { id: solid.newMessageId(address, 1792630000), pubkey: me, created_at: 1792630000, content: 'hello; "dot." \\ end\nline 2', reply: `${solid.dayUrl(address, 1792600000)}#m0` };
  assert.match(message.id, /^https:\/\/pod\.example\/alice\/chats\/lobby\/2026\/10\/22\/chat\.ttl#m[0-9a-z]+$/);
  const patch = solid.appendPatch(address, message);
  assert.match(patch, /^@prefix solid: <http:\/\/www\.w3\.org\/ns\/solid\/terms#>\.\n_:p a solid:InsertDeletePatch; solid:inserts \{\n/);
  assert.ok(!patch.includes('solid:deletes'));
  const body = patch.slice(patch.indexOf('{') + 1, patch.lastIndexOf('}'));
  const triples = parseTurtle(body, solid.stripFragment(message.id));
  const { messages } = solid.parseDay(triples, address);
  assert.equal(messages.length, 1);
  const got = messages[0];
  assert.equal(got.id, message.id);
  assert.equal(got.pubkey, me);
  assert.equal(got.created_at, 1792630000);
  assert.equal(got.content, message.content);
  assert.equal(got.reply, message.reply);
  assert.equal(got.edited, false);
  assert.equal(got.raw.length, 6);
});

test('parseDay reads SolidOS-style files: linked messages, replies via has_reply, reactions, deleted', () => {
  const dayUrl = 'https://pod.example/alice/chats/lobby/2026/10/22/chat.ttl';
  const triples = parseTurtle(`@prefix wf: <http://www.w3.org/2005/01/wf/flow#>.
@prefix sioc: <http://rdfs.org/sioc/ns#>.
@prefix dct: <http://purl.org/dc/terms/>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix schema: <http://schema.org/>.
@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
<${address}> wf:message <#Msg1>, <#Msg2>, <#Msg3>.
<#Msg1> dct:created "2026-10-22T09:00:00Z"^^xsd:dateTime; sioc:content "first"; foaf:maker <https://bob.pod/profile/card#me>; sioc:has_reply <#Msg2>.
<#Msg2> dct:created "2026-10-22T09:01:00Z"^^xsd:dateTime; dct:modified "2026-10-22T09:05:00Z"^^xsd:dateTime; sioc:content "reply (edited)"; foaf:maker <did:nostr:${me}>.
<#Msg3> dct:created "2026-10-22T09:02:00Z"^^xsd:dateTime; sioc:content "gone"; foaf:maker <did:nostr:${me}>; schema:dateDeleted "2026-10-22T09:03:00Z"^^xsd:dateTime.
<#R1> a schema:ReactAction; schema:about <#Msg1>; schema:agent <did:nostr:${me}>; schema:name "👍".
<#junk> sioc:content "no date or maker".`, dayUrl);
  const { messages, reactions } = solid.parseDay(triples, address);
  assert.deepEqual(messages.map((m) => [m.id.split('#')[1], m.pubkey, m.content, m.reply?.split('#')[1], m.edited, m.deleted]), [
    ['Msg1', 'https://bob.pod/profile/card#me', 'first', undefined, false, false],
    ['Msg2', me, 'reply (edited)', 'Msg1', true, false],
    ['Msg3', me, 'gone', undefined, false, true],
  ]);
  assert.deepEqual(reactions.map((r) => [r.id.split('#')[1], r.pubkey, r.target.split('#')[1], r.emoji]), [['R1', me, 'Msg1', '👍']]);
});

test('edit, delete and reaction patches touch only the message they are about', () => {
  const message = { id: `${solid.dayUrl(address, 1792630000)}#m1`, pubkey: me, created_at: 1792630000, content: 'old' };
  message.raw = solid.messageTriples(address, message);
  const edit = solid.editPatch(message, 'new', 1792630100);
  assert.ok(edit.includes('solid:deletes') && edit.includes('"old"') && edit.includes('"new"') && edit.includes('dc/terms/modified'));
  const del = solid.deletePatch(message);
  assert.ok(del.includes('solid:deletes') && !del.includes('solid:inserts'));
  assert.equal((del.match(/<https:\/\/pod\.example[^>]*#m1>/g) ?? []).length, 4);
  const reaction = { id: solid.newReactionId(message, 1792630200), pubkey: me, target: message.id, emoji: '🔥', created_at: 1792630200 };
  const react = solid.reactionPatch(message, reaction);
  assert.ok(react.includes('schema.org/ReactAction') && react.includes('"🔥"') && react.includes(`did:nostr:${me}`));
  assert.ok(reaction.id.startsWith(solid.stripFragment(message.id) + '#r'), 'reaction lives in the message day file');
});

test('chat index and ACL documents are valid Turtle with the owner as did:nostr', () => {
  const index = parseTurtle(solid.chatIndexTurtle({ name: 'Lobby "quoted"', owner: me, created: 1792630000 }), 'https://pod.example/x/index.ttl');
  const chat = solid.parseChat(index, 'https://pod.example/x/index.ttl#this');
  assert.deepEqual([chat.name, chat.owner, chat.created, chat.root], ['Lobby "quoted"', me, 1792630000, 'https://pod.example/x/']);
  const acl = parseJsonLd(solid.chatAcl(me), 'https://pod.example/x/.acl');
  const modes = (s) => acl.filter((t) => t.s === s && t.p === 'http://www.w3.org/ns/auth/acl#mode').map((t) => t.o.value.split('#')[1]).sort();
  assert.deepEqual(modes('https://pod.example/x/.acl#owner'), ['Control', 'Read', 'Write']);
  assert.deepEqual(modes('https://pod.example/x/.acl#public'), ['Append', 'Read']);
  assert.ok(acl.some((t) => t.p === 'http://www.w3.org/ns/auth/acl#agent' && t.o.value === `did:nostr:${me}`));
  assert.ok(!JSON.stringify(solid.chatAcl(me, { open: false })).includes('#public'));
});

test('WAC-Allow parsing', () => {
  const w = solid.parseWacAllow('user="read append", public="read"');
  assert.deepEqual([...w.user].sort(), ['append', 'read']);
  assert.deepEqual([...w.public], ['read']);
  assert.deepEqual([...solid.parseWacAllow(null).user], []);
});

test('type index: registrations are read (instances and containers) and written as insert-only patches', async () => {
  const idx = 'https://pod.example/alice/settings/publicTypeIndex.ttl';
  const triples = parseTurtle(`@prefix solid: <http://www.w3.org/ns/solid/terms#>.
@prefix meeting: <http://www.w3.org/ns/pim/meeting#>.
<#a> a solid:TypeRegistration; solid:forClass meeting:LongChat; solid:instance <../chats/lobby/index.ttl#this>, <https://other.pod/x/index.ttl#this>.
<#b> a solid:TypeRegistration; solid:forClass meeting:LongChat; solid:instanceContainer <../chats/>.
<#c> a solid:TypeRegistration; solid:forClass <http://www.w3.org/2002/01/bookmark#Bookmark>; solid:instance <../bookmarks.ttl>.`, idx);
  // listRegisteredChats fetches; exercise the same parsing through the patch builder and parseTurtle instead.
  const regs = triples.filter((t) => t.p === 'http://www.w3.org/ns/solid/terms#forClass' && t.o.value === 'http://www.w3.org/ns/pim/meeting#LongChat').map((t) => t.s);
  assert.deepEqual(regs, [`${idx}#a`, `${idx}#b`]);
  const patchText = await (async () => {
    let body;
    const fakeSigner = { pubkey: me, sign: async (t) => finalizeEvent(t, sk) };
    globalThis.fetch = async (url, init) => { body = init.body; return new Response(null, { status: 204 }); };
    await solid.registerChat(fakeSigner, idx, address);
    return body;
  })();
  assert.ok(patchText.includes('solid:inserts') && !patchText.includes('solid:deletes'));
  assert.ok(patchText.includes('<http://www.w3.org/ns/solid/terms#TypeRegistration>') && patchText.includes(`<${address}>`) && patchText.includes('LongChat'));
});
