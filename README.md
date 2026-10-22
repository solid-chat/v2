# Solid Chat v2

A no-build Preact client for chat rooms that live on [Solid](https://solidproject.org) pods, plus end-to-end encrypted direct messages over Nostr. One key signs in to both. Live at [solid-chat.com/v2](https://solid-chat.com/v2/).

- **Rooms are Solid chats.** A room is a folder on a pod in the [Solid chat format](https://solid.github.io/chat/): `index.ttl#this` is a `meeting:LongChat`, and each UTC day's messages are in `YYYY/MM/DD/chat.ttl` as `wf:message` subjects with `sioc:content`, `dct:created` and `foaf:maker`. Rooms made with the earlier Solid Chat app, SolidOS and other spec clients open here, and rooms made here open there. Posting is an N3 Patch append; reactions are `schema:ReactAction` nodes; replies use `sioc:has_reply`; edits and deletions patch the message in place (pod permitting).
- **Identity:** your Nostr key. In links and copy buttons people are [did:nostr](https://did-nostr.com) (`did:nostr:<hex pubkey>`); `npub` is display only. Pod requests are signed with NIP-98 (kind 27235), which [JSS](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer) pods accept directly: a `did:nostr:` agent can be named in ACLs or linked to a WebID. People posting from other Solid apps appear by their WebID, with name and picture read from their profile document.
- **Live:** rooms update over the pod's solid-0.1 WebSocket (`Updates-Via`), with a slow poll as backstop. History is paged a day file at a time by listing the chat's year, month and day folders.
- **Permissions:** rooms created here grant the public Read and Append and the owner everything, so anyone with the link can post but only the owner can edit or delete. The app reads `WAC-Allow` and offers edit and delete only where the pod allows Write.
- **DMs:** NIP-17 kind 14 rumors, sealed and gift-wrapped with NIP-44, sent to the recipient's kind 10050 inbox relays, compatible with [Anagram](https://github.com/lnbits/anagram) and [nostr.chat](https://nostr.chat). Decrypted messages are cached in IndexedDB.
- **Contacts and blocks:** Anagram's private contact list (kind 30000) and mute list (kind 10000), shared with those apps. Read marks, pins and mutes sync between your devices in an encrypted kind 30078 (`d=solid-chat`).
- **Media:** photos, video and audio upload to a Blossom server (default `blossom.nostr.build`) and are sent as NIP-92 `imeta` attachments with the URL in the text.
- **Login:** nsec (kept in localStorage), NIP-07 extension (needs NIP-44), or a NIP-46 `bunker://` signer.

## Running it against a pod

Rooms hosted by others need nothing: open the room's link or paste its address (`https://pod/…/index.ttl#this`, the folder, or the index file). To create rooms you need a pod folder your key may write to, set under Settings → Your pod. On JSS (0.0.223 or later, see below) that is any folder whose `.acl` grants `did:nostr:<your hex>` Write and Control, or your own pod once your profile lists the key as a verification method.

For development: `npx serve .` here and, in another terminal, a local JSS (`jss start --port 5447 --root ./data --single-user --single-user-name alice --idp --notifications --conneg`). Put a chat folder with an `index.ttl` and a public-append `.acl` under `data/alice/public/` (the shapes are in `js/solid.js`: `chatIndexTurtle` and `chatAclTurtle`) and open `http://localhost:5447/alice/public/<folder>/` from the New screen. The page's CSP allows `http://localhost:*` and `ws://localhost:*` for this.

JSS before 0.0.223 loses triples on PATCH and requires Write for every PATCH; the fix (quad-based patching, Append for insert-only patches) is in [JavaScriptSolidServer PR](https://github.com/JavaScriptSolidServer/JavaScriptSolidServer/pulls) `fix/patch-with-n3`.

## Interoperability

[docs/SPEC.md](docs/SPEC.md) is the wire profile: the chat format as this client writes and reads it, the identity rules, the NIP-17 DM profile, lists, media and policy, with a conformance summary for other clients. Keep it in step with code changes.

## Privacy

What leaves your device, and to whom (also at [solid-chat.com/v2/privacy](https://solid-chat.com/v2/privacy)).

- **Pods** that host the rooms you open see your IP, the rooms you read, and what you post (rooms are stored in the open, readable by whoever the folder's permissions allow). Writes carry a NIP-98 event signed by your key, so the pod learns your public key; reads are anonymous unless the pod demands otherwise.
- **Relays** (`APP_RELAYS` in `js/transport.js` plus the inbox relays people publish) see your IP and the gift-wrapped DMs you send and receive, not their contents.
- **nostr.social** (the did:nostr directory) is asked for profiles, people search and follow lists; it sees your IP and which keys you look up. Everything it returns is a signed event verified locally.
- **WebID profile documents** of people who post from other Solid apps are fetched for their name and picture.
- **Blossom** (`blossom.nostr.build` by default) receives the files you upload, with a kind 24242 auth event.
- **Avatars and media hosts**: profile pictures load automatically from wherever a profile points (no referrer). Images in rooms and from contacts load automatically; from strangers in DMs you tap "Show media" first.
- **Your key** stays in this browser (localStorage) or in your NIP-07 extension / NIP-46 signer. No account server, no analytics, no third-party scripts (the CSP allows only same-origin code).

## Run

Serve the folder with any static server and open it. Code layout (plain ES modules, no build): `js/app.js` is the root; `js/ui/` the views by feature; `js/store.js` the public state and action surface, implemented in `js/store/` (`core`, `accounts`, `prefs`, `people`, `messages`, `dms`, `rooms`, `media`); `js/solid.js` is the only module that talks to pods (NIP-98, the chat format, patches, live updates), `js/turtle.js` a small Turtle and JSON-LD reader and Turtle writer, `js/nostr.js` the Nostr protocol helpers, `js/transport.js` the only relay access, `js/db.js` the IndexedDB cache. Preact, signals, htm and nostr-tools are vendored as pinned ES modules in `vendor/` (checksums in `SHA256SUMS`) and wired up by the import map in `index.html`. `npm test` runs the Turtle and chat-format tests; `npm run check` syntax-checks every served module and verifies the vendored checksums. The `gh-pages` branch is the site.

Not included yet: private (encrypted) rooms, Solid-OIDC sign-in for pods that do not accept Nostr keys, uploads to the pod itself, push notifications when the tab is closed.

## License

AGPL-3.0-only. A clean rewrite of [solid-chat/app](https://github.com/solid-chat/app) sharing its chat format, built on the [nostr.chat](https://github.com/melvincarvalho/anagram) client.
