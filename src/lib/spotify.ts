// Connecting the user's Spotify account (OAuth on the server; tokens never reach the browser).
import { api } from './api';
import { toast } from '../components/Toast';

/** Start the Spotify consent flow and come back to `returnPath` (default: this page). */
export async function connectSpotify(returnPath?: string): Promise<void> {
  try {
    const path = returnPath ?? window.location.pathname;
    const r = await api.spotifyAuthorize(`${window.location.origin}${path}`);
    window.location.href = r.url;
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/**
 * After the OAuth redirect the app opens with ?spotify=connected|denied: confirm it once and
 * clean the URL. Returns whether the account was just connected.
 */
export function consumeSpotifyReturn(): boolean | null {
  const url = new URL(window.location.href);
  const p = url.searchParams.get('spotify');
  if (!p) return null;
  toast(p === 'connected' ? 'Spotify connected.' : 'Spotify connection was cancelled.', p === 'connected' ? 'info' : 'error');
  url.searchParams.delete('spotify');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return p === 'connected';
}
