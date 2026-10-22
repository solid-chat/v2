# Solid Chat v2 interoperability profile

What Solid Chat puts on the wire and what it accepts. Written from the code (`js/solid.js`,
`js/turtle.js`, `js/nostr.js`, `js/store/`) for anyone who wants to read or write the
same chats from another client, a bot or a pod, without reading this client. It is a
profile of existing specifications (the Solid Protocol, the Solid chat format, NIP-98,
NIP-17 and friends), not a new protocol: where this document and a specification
disagree, that is a bug here.

Status: describes the client as deployed at https://solid-chat.com/v2/ on 2026-10-22.
"MUST", "SHOULD" and "MAY" describe what *this client* does; **Tolerated** marks input
accepted beyond what it sends.

Contents

1. Identity
2. Pods: signed requests, reading, live updates
3. Chat rooms (Solid chat format)
4. Direct messages (NIP-17)
5. Private lists and settings
6. Media
7. Trust and policy
8. Conformance summary
9. Known gaps

---

## 1. Identity

1.1 A person signed in here is a secp256k1 key, written `did:nostr:<64 hex>` in links,
copy buttons and in the chat files (`foaf:maker <did:nostr:…>`). `npub1…` is display
only. Inputs accept a `did:nostr:` URI, bare hex, `npub`, `nprofile`, `nostr:` forms, a
`name@domain` NIP-05 address, and profile links `https://nostr.social/<hex>` and
`…/#/dm/did:nostr:<hex>`.

1.2 Anyone else who posts in a chat is identified by the IRI in `foaf:maker`, normally a
WebID (`https://…/profile/card#me`). The client fetches that document (2.2) and shows
`foaf:name` / `vcard:fn` / `schema:name` and `foaf:img` / `vcard:hasPhoto` /
`foaf:depiction`. Such people cannot be messaged or blocked from here; their profile opens
in a new tab.

1.3 Nostr profiles (kind 0), their publishing rules, NIP-05 verification and did:nostr
document resolution via nostr.social are unchanged from nostr.chat: see that client's
profile, sections 1.2–1.5.

## 2. Pods: signed requests, reading, live updates

2.1 **Signed requests (NIP-98).** A write, and a read the pod refuses anonymously, carries
`Authorization: Nostr <base64 JSON>` of a signed kind 27235 event with tags
`['u', <exact request URL>]`, `['method', <METHOD>]` and, when there is a body,
`['payload', <sha256 hex of the body bytes>]`; `created_at` is now (pods allow ±60 s).
Reads are attempted anonymously first and signed only after a 401/403, so public pods
never learn who is reading. The client never sends cookies or OIDC tokens.

2.2 **Reading RDF.** `GET` with `Accept: text/turtle, application/ld+json;q=0.9,
application/n-triples;q=0.8, text/n3;q=0.7`; the response is parsed by its
`Content-Type`. Turtle is read with the subset in `js/turtle.js` (prefixes, `a`, predicate
and object lists, blank nodes, collections, all literal forms, `@base`). JSON-LD is read
in the subset Solid servers store: a `@context` of prefix strings and `@id`-typed aliases,
a node or a `@graph`, values as strings, `{ "@id" }`, `{ "@value", "@type" }` and
`{ "@value", "@language" }`. Relative IRIs resolve against the document URL without its
fragment. `If-None-Match` with the last `ETag` avoids re-reading unchanged day files.

2.3 **Permissions.** The `WAC-Allow` header of the index and day files decides what the
UI offers: `append` (or `write`) for posting, `write` for edit, delete and reaction
removal. Without `append` the room is shown read-only.

2.4 **Live updates** use the solid-0.1 protocol: the socket named by the `Updates-Via`
header (one connection per origin, `sub <url>` per watched document, `pub <url>` on
change, resubscribed after reconnect with exponential backoff). Today's day file is
watched; the watch moves at UTC midnight. A 45 s poll while the tab is visible, and a
re-read when it becomes visible, back the socket up. **Tolerated**: a pod without
`Updates-Via` is polled only.

2.5 **Writes** are `PATCH` with `Content-Type: text/n3` (N3 Patch). A patch that only
inserts triples needs `acl:Append`; one with `solid:deletes` needs `acl:Write`. The pod
creates a missing day file (and its folders) on PATCH. The client writes patches in the
plainest Turtle: full IRIs in angle brackets, one triple per statement, typed literals as
`"…"^^<iri>`, strings escaped (`\n`, `\"`, `\\`, `\t`), no prefixes other than
`solid:`.

## 3. Chat rooms (Solid chat format)

3.1 **Address.** A room is identified by its channel IRI, `<root>/index.ttl#this`.
Inputs accept that IRI, the folder `<root>/`, the index file, and this app's links
`#/room/<url-encoded IRI>`. The root is the IRI up to its last `/`.

3.2 **Index.** `<root>/index.ttl` holds `<#this> a meeting:LongChat` with `dc:title`
(`dct:title` and `schema:name` tolerated), `dct:created` and `foaf:maker` (the owner;
`dc:author` and `dct:creator` tolerated). `dct:description` / `schema:description` and
`schema:image` (https only) are shown when present. A channel without `meeting:LongChat`
but with any triples is **tolerated**; a missing index is an error.

3.3 **Day files.** Messages for a UTC date live in `<root>/YYYY/MM/DD/chat.ttl`. A message
is a subject with exactly these mandatory properties, as the Solid chat specification
requires: `dct:created` (xsd:dateTime, UTC), `sioc:content` (the text), `foaf:maker`
(1.1/1.2), and is linked from the channel with `<channel> wf:message <message>`.
**Tolerated**: a subject in the day file with the three properties but no `wf:message`
link is shown too. Subjects missing any of the three are ignored.

3.4 **Message IRIs** written by this client are `<day file>#m<base36 seconds><8 hex>`.
Any fragment is accepted when reading (SolidOS writes `#Msg<ms>`).

3.5 **Posting** appends, in one N3 Patch, the `wf:message` link and the three
properties; a reply additionally inserts `<original> sioc:has_reply <message>` and
`<message> sioc:reply_of <original>` (the spec's property and its inverse, so readers
need not search other day files). Replies are read from either. The original may be in
an earlier day file; it is fetched on demand to show the quote.

3.6 **Edits** replace `sioc:content` in place and set `dct:modified` (deleting the old
value and any previous `dct:modified`) in one patch with `solid:deletes` and
`solid:inserts`. A message whose `dct:modified` is later than `dct:created` is marked
"edited". **Tolerated**: `dct:isReplacedBy` chains are not followed yet (9).

3.7 **Deletions** remove every triple of the message (its properties and the
`wf:message` link). When reading, a message with `schema:dateDeleted` is treated as
deleted; a message that disappears from a re-read day file is removed locally.

3.8 **Reactions** are `schema:ReactAction` nodes in the day file of the message:
`schema:about <message>`, `schema:agent <did:nostr:…|WebID>`, `schema:name "<emoji>"`,
`dct:created`. Their IRIs are `<day file>#r<base36 seconds><6 hex>`. Reacting again with
the same emoji deletes the node (needs Write).

3.9 **History.** The client lists `<root>/` for `YYYY/` children, each for `MM/`, each
for `DD/` (via `ldp:contains`), and reads day files newest first until a page is full.
Day files are cached locally (newest 300 messages per room) and shown before the
network answers.

3.10 **Creating a room** writes `<pod folder>/<slug>-<base36 time>/index.ttl` (3.2) and
`.acl` granting the owner `Read, Write, Control` and, for an open room, `foaf:Agent`
`Read, Append`, both with `acl:accessTo <./>` and `acl:default <./>` so day files
inherit. Both are `PUT` with `text/turtle` and a NIP-98 header.

3.11 **Length.** Content up to 20,000 UTF-16 units is sent and shown; longer messages are
dropped when reading.

## 4. Direct messages (NIP-17)

Unchanged from nostr.chat's profile (sections 3.1–3.11 there), in brief: kind 14
rumors (replies `['e', id, '', 'reply']`, edits `['e', id, '', 'edit']` with the
original's `created_at`), kind 7 reactions, kind 5 deletions honoured only from the
author, sealed (kind 13) and gift-wrapped (kind 1059) with NIP-44, fuzzed timestamps,
an own copy to `'self'`, delivery judged by the recipient's kind 10050 inbox relays
(else their NIP-65 read relays, else the app relays). Group DMs are dropped with a
one-time notice. Kind 15 file messages are received, not sent.

## 5. Private lists and settings

5.1 **Contacts**: kind 30000 `d=contacts` (NIP-44 to self), shared with Anagram and
nostr.chat. 5.2 **Mute list**: kind 10000 with private `['bp', hex]` entries; only hex
keys can be blocked. 5.3 **Settings sync**: kind 30078 with `['d', 'solid-chat']`,
content as nostr.chat's version-1 document (`read`, `pinned`, `muted`, `hidden`), where
chat keys are peer hex or room IRIs. nostr.chat's own `d=nostr.chat` event is never read
or written.

## 6. Media

6.1 Uploads go to a Blossom server (`PUT /upload`, kind 24242 auth, `image/*`,
`video/*`, `audio/*` up to 20 MiB) and the URL goes into the text; in rooms the URL is
all other clients see, in DMs an `imeta` tag is added as well. 6.2 `DELETE /<sha256>`
removes an upload. 6.3 Media and avatars load with `Referrer-Policy: no-referrer`.

## 7. Trust and policy

7.1 Everyone in a room may post links and media; blocking is local (5.2) and applies
only to hex keys. 7.2 Deletions in rooms are whatever the pod's ACL allows; this client
offers delete and edit only on the user's own messages and only with `write` in
`WAC-Allow`. 7.3 DM message requests, notifications and mentions are as in nostr.chat
(sections 8.1–8.4 there); a room message mentions the account when its text contains
the account's `did:nostr:`, `npub` or an `nprofile` that decodes to it.

## 8. Conformance summary

To share a room with Solid Chat users, a client needs to:

- Keep the Solid chat layout: `index.ttl#this` as `meeting:LongChat`, day files at
  `YYYY/MM/DD/chat.ttl` by UTC date, messages linked with `wf:message` and carrying
  `dct:created`, `sioc:content`, `foaf:maker` (3.2–3.3).
- Append with an insert-only N3 Patch so pods can allow it with `acl:Append` (2.5).
- Mark replies with `sioc:has_reply` on the original (3.5); reactions as
  `schema:ReactAction` (3.8); edits with `dct:modified` (3.6).
- Identify people by WebID or `did:nostr:` IRI in `foaf:maker` (1.1–1.2).

To host such rooms, a pod needs to: accept `PATCH` with `text/n3` and create missing
resources; treat insert-only patches as `Append`; send `WAC-Allow`; serve Turtle or
JSON-LD; offer `Updates-Via` for live updates; and, to let Nostr keys post or own
rooms, verify NIP-98 and name `did:nostr:` agents in ACLs (JSS does all of this from
0.0.223).

To message a Solid Chat user privately, follow the NIP-17 profile (4).

## 9. Known gaps

- `dct:isReplacedBy` edit chains and `sioc:Thread` threads from the spec are read as
  plain messages.
- Reactions and replies are only written to a pod where the user has `Append`; removing
  a reaction, editing and deleting need `Write`, which open rooms grant only to their
  owner. There is no per-message ownership in WAC.
- Solid-OIDC is not implemented: a pod that does not accept NIP-98 can host rooms you read
  but not rooms you create.
- Uploads go to Blossom, not to the pod.
- No push notifications while the tab is closed; no encrypted rooms.
