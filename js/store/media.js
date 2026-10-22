// Media uploads: the pod for rooms, Blossom for everything else.
import { signal } from '@preact/signals';
import * as nostr from '../nostr.js';
import * as solid from '../solid.js';
import { me, roomState, storage } from './core.js';

// ---------- Media uploads ----------

export const mediaServer = signal(storage.get('lite:blossom', nostr.DEFAULT_BLOSSOM));
export function setMediaServer(value) {
  const origin = nostr.normalizeBlossomServer(value);
  if (!origin) throw new Error('Enter an https:// server address without a path.');
  mediaServer.value = origin;
  storage.set('lite:blossom', origin);
}
// In a room the file goes to the room's own folder on the pod (<root>files/); elsewhere
// (DMs, profile pictures) to the Blossom server.
export const uploadMedia = (file, target) =>
  target?.room ? solid.uploadFile(me.value, roomState.value[target.room]?.room?.root ?? solid.chatRoot(target.room), file) : nostr.uploadBlossom(me.value, file, mediaServer.value);

// The uploaded files a message points at: imeta attachments, plus in a room any URL
// in the text that lives under the room's files/ folder (the pod keeps no imeta).
export function filesOf(message, room) {
  const list = nostr.uploadsOf(message).map((f) => ({ ...f, pod: !!room && f.url.startsWith(`${room.root}files/`) }));
  if (room) for (const url of message.content.match(/https?:\/\/[^\s<>"']+/g) ?? []) if (url.startsWith(`${room.root}files/`) && !list.some((f) => f.url === url)) list.push({ url, pod: true });
  return list;
}

// Remove the files one of our messages uploaded from where they live (the pod for room
// uploads, Blossom otherwise). The message itself stays. Resolves to the file count.
export async function deleteMedia(message, room) {
  if (message.pubkey !== me.value.pubkey) throw new Error('You can only remove your own files.');
  const files = filesOf(message, room);
  if (!files.length) throw new Error('This message has no uploaded file.');
  await Promise.all(files.map((f) => (f.pod ? solid.deleteFile(me.value, f.url) : nostr.deleteBlossom(me.value, f.url, f.sha256))));
  return files.length;
}
