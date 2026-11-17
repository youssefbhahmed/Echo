// One sound at a time. ECHO's music (Spotify Connect or the Spotify embed) and its YouTube players never
// play over each other: whichever starts claims the sound, and the others pause. This also keeps the two
// services apart — Spotify playback is never mixed or overlapped with other audio (Spotify Developer
// Policy), and only one YouTube player ever plays at once (YouTube's embedded-player rules).

/** The music queue (mini player); a YouTube player claims as `youtube:<its own id>`. */
export const MUSIC = 'music';

type Listener = (owner: string) => void;
const listeners = new Set<Listener>();

/** `owner` started playing: every other player pauses. */
export function claimSound(owner: string): void {
  for (const l of [...listeners]) l(owner);
}

/** Be told when a player starts (`owner`), to pause when it isn't you. Returns the unsubscribe. */
export function onSoundClaimed(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}
