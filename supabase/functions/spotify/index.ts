// Spotify user authorization (Authorization Code + PKCE), playlist creation and Spotify Connect playback.
//   POST { action: 'authorize', redirectTo }  → { url }   (user then consents on accounts.spotify.com)
//   GET  ?code&state                          → OAuth callback, stores tokens server-side, redirects back to the app
//   POST { action: 'status' }                 → { connected, scope, since, canPlay }
//   POST { action: 'disconnect' | 'create-playlist' }
//   POST { action: 'player-state' | 'devices' | 'play' | 'next' | 'previous' | 'pause' | 'resume' }  (Premium, full songs)
// Tokens are stored in public.oauth_tokens, which is unreadable from the browser (RLS + revoked privileges).
// Uses the Feb-2026 endpoints: POST /v1/me/playlists and POST /v1/playlists/{id}/items.
import { z } from 'npm:zod@4.6.7';
import { SpotifyBody } from '../_shared/schemas.ts';
import { env, getItems, HttpError, json, rateLimit, readJson, requireUser, serve, serviceClient } from '../_shared/server.ts';
import { canPlayWith, mapDevices, mapPlayerState, mapSpotifyError, PLAYABLE_URI, pickDevice, type PlayerErrorInfo, SCOPES, shuffleOffPath } from './player.ts';

const API = 'https://api.spotify.com/v1';

const PlayerBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('player-state') }),
  z.object({ action: z.literal('devices') }),
  z.object({
    action: z.literal('play'),
    uris: z.array(z.string().regex(PLAYABLE_URI)).min(1).max(100),
    offset: z.number().int().min(0).max(99).optional(),
    deviceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
    /** Spotify's shuffle setting as the client last saw it (omitted when unknown). */
    shuffle: z.boolean().optional(),
  }),
  z.object({ action: z.literal('next') }),
  z.object({ action: z.literal('previous') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
]);
const PLAYER_ACTIONS = new Set(['player-state', 'devices', 'play', 'next', 'previous', 'pause', 'resume']);

/** A Spotify player failure with a stable code (and Retry-After for rate limits). */
class PlayerError extends HttpError {
  retryAfter?: number;
  constructor(info: PlayerErrorInfo) {
    super(info.status, info.message, info.code);
    this.retryAfter = info.retryAfter;
  }
}

function redirectUri(): string {
  return env('SPOTIFY_REDIRECT_URI') ?? `${env('SUPABASE_PUBLIC_URL') ?? env('SUPABASE_URL')}/functions/v1/spotify`;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function allowedRedirect(req: Request, target: string): boolean {
  const origin = new URL(target).origin;
  const list = (env('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  return origin === req.headers.get('Origin');
}

async function tokenRequest(params: Record<string, string>) {
  const id = env('SPOTIFY_CLIENT_ID')!;
  const secret = env('SPOTIFY_CLIENT_SECRET')!;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    await res.body?.cancel();
    // 400/401 = revoked or expired grant: the user has to connect again (never 401: that would sign them out of ECHO).
    if (res.status === 400 || res.status === 401) throw new HttpError(409, 'Your Spotify sign-in expired. Please reconnect Spotify.', 'reconnect');
    throw new HttpError(502, `Spotify token exchange failed (${res.status})`, 'spotify_error');
  }
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

/** The stored Spotify link. A database hiccup is a temporary error, never "not connected" (that would end full songs). */
async function readToken(userId: string) {
  const { data, error } = await serviceClient().from('oauth_tokens').select('*').eq('user_id', userId).eq('provider', 'spotify').maybeSingle();
  if (error) throw new HttpError(503, 'Spotify link could not be read. Try again.', 'spotify_error');
  return data;
}

/** A valid access token for this user, refreshed (and the rotated refresh token persisted) when needed. */
async function userToken(userId: string, opts: { force?: boolean; playback?: boolean } = {}): Promise<string> {
  const data = await readToken(userId);
  if (!data) throw new HttpError(409, 'Connect Spotify first (Settings → Connected platforms).', 'spotify_not_connected');
  if (opts.playback && !canPlayWith(data.scope)) throw new HttpError(409, 'Full songs need one more Spotify permission. Reconnect Spotify.', 'reconnect');
  if (!opts.force && new Date(data.expires_at).getTime() - 60_000 > Date.now()) return data.access_token;
  if (!data.refresh_token) throw new HttpError(409, 'Spotify session expired. Please reconnect.', 'reconnect');
  let t: Awaited<ReturnType<typeof tokenRequest>>;
  try {
    t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: data.refresh_token });
  } catch (e) {
    // Two requests refreshing at once (the player's poll next to a tap): Spotify may have rotated the refresh token for
    // the other one, which then stored fresh tokens. Use those instead of asking the user to reconnect.
    if (e instanceof HttpError && e.code === 'reconnect') {
      const fresh = await readToken(userId).catch(() => null);
      const renewed = !!fresh && (fresh.refresh_token !== data.refresh_token || fresh.access_token !== data.access_token);
      if (fresh && renewed && new Date(fresh.expires_at).getTime() - 60_000 > Date.now()) return fresh.access_token;
    }
    throw e;
  }
  await serviceClient().from('oauth_tokens').update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? data.refresh_token, scope: t.scope ?? data.scope,
    expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('provider', 'spotify');
  return t.access_token;
}

// Per-instance memory of Spotify 429s, so a rate-limited user doesn't keep hitting Spotify while it lasts.
const backoff = new Map<string, number>();

/** Call the Spotify Web API as the user. Retries once with a fresh token on 401; maps failures to PlayerError. */
async function spotifyApi(userId: string, method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<unknown> {
  const until = backoff.get(userId) ?? 0;
  if (until > Date.now()) throw new PlayerError({ status: 429, code: 'rate_limited', message: 'Spotify is busy right now. Try again in a moment.', retryAfter: Math.ceil((until - Date.now()) / 1000) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await userToken(userId, { force: attempt > 0, playback: true });
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      // Spotify answers 411 to a PUT/POST without a length, so send an explicit empty body.
      body: body !== undefined ? JSON.stringify(body) : method === 'GET' ? undefined : '',
    });
    if (res.status === 401 && attempt === 0) {
      await res.body?.cancel();
      continue;
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    const info = mapSpotifyError(res.status, data, res.headers.get('Retry-After'));
    if (info.retryAfter) backoff.set(userId, Date.now() + info.retryAfter * 1000);
    throw new PlayerError(info);
  }
  throw new PlayerError(mapSpotifyError(401, null));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handlePlayer(req: Request, userId: string, raw: unknown): Promise<Response> {
  const body = PlayerBody.parse(raw);
  switch (body.action) {
    case 'player-state':
      return json(req, mapPlayerState(await spotifyApi(userId, 'GET', '/me/player?additional_types=episode')));
    case 'devices':
      return json(req, { devices: mapDevices(await spotifyApi(userId, 'GET', '/me/player/devices')) });
    case 'next':
      await spotifyApi(userId, 'POST', '/me/player/next');
      return json(req, { ok: true });
    case 'previous':
      await spotifyApi(userId, 'POST', '/me/player/previous');
      return json(req, { ok: true });
    case 'pause':
      await spotifyApi(userId, 'PUT', '/me/player/pause');
      return json(req, { ok: true });
    case 'resume':
      await spotifyApi(userId, 'PUT', '/me/player/play');
      return json(req, { ok: true });
    case 'play': {
      const payload = { uris: body.uris, offset: { position: Math.min(body.offset ?? 0, body.uris.length - 1) } };
      // Shuffle persists from the user's Spotify app and would scramble the lane: turn it off once playing (best effort;
      // skipped when the client last saw it off, to spare the shared rate limit).
      const inOrder = async (deviceId?: string) => {
        if (body.shuffle === false) return;
        await spotifyApi(userId, 'PUT', shuffleOffPath(deviceId)).catch(() => undefined);
      };
      try {
        await spotifyApi(userId, 'PUT', `/me/player/play${body.deviceId ? `?device_id=${encodeURIComponent(body.deviceId)}` : ''}`, payload);
        await inOrder(body.deviceId);
        return json(req, { ok: true, device: null });
      } catch (e) {
        if (!(e instanceof PlayerError) || e.code !== 'no_device') throw e;
      }
      // Nothing active: wake the best available device (the Spotify app on the phone, ideally), then retry once.
      const device = pickDevice(mapDevices(await spotifyApi(userId, 'GET', '/me/player/devices')));
      if (!device) throw new PlayerError({ status: 409, code: 'no_device', message: 'Open Spotify to start playing.' });
      await spotifyApi(userId, 'PUT', '/me/player', { device_ids: [device.id], play: false });
      await sleep(300);
      await spotifyApi(userId, 'PUT', `/me/player/play?device_id=${encodeURIComponent(device.id)}`, payload);
      await inOrder(device.id);
      return json(req, { ok: true, device: { id: device.id, name: device.name, type: device.type } });
    }
  }
}

serve(async (req) => {
  if (!env('SPOTIFY_CLIENT_ID') || !env('SPOTIFY_CLIENT_SECRET')) throw new HttpError(503, 'Spotify is not configured on this server.', 'spotify_unconfigured');

  // ── OAuth callback (browser redirect from Spotify; no ECHO JWT available here) ──
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const state = u.searchParams.get('state') ?? '';
    const { data: st } = await serviceClient().from('oauth_states').select('*').eq('state', state).maybeSingle();
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return new Response('This Spotify sign-in link has expired. Please try connecting again from ECHO.', { status: 400 });
    await serviceClient().from('oauth_states').delete().eq('state', state);
    const back = new URL(st.redirect_to);
    const code = u.searchParams.get('code');
    if (!code) {
      back.searchParams.set('spotify', 'denied');
      return Response.redirect(back.toString(), 302);
    }
    const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: st.code_verifier });
    const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    await serviceClient().from('oauth_tokens').upsert({
      user_id: st.user_id, provider: 'spotify', access_token: t.access_token, refresh_token: t.refresh_token ?? null, scope: t.scope ?? SCOPES,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), external_user_id: me?.id ?? null, updated_at: new Date().toISOString(),
    });
    back.searchParams.set('spotify', 'connected');
    return Response.redirect(back.toString(), 302);
  }

  const { userId } = await requireUser(req);
  const raw = await readJson<Record<string, unknown>>(req);

  // Playback control: its own, roomier bucket (the player polls every few seconds while visible).
  if (typeof raw?.action === 'string' && PLAYER_ACTIONS.has(raw.action)) {
    await rateLimit(userId, 'spotify-player', 120, 60);
    try {
      return await handlePlayer(req, userId, raw);
    } catch (e) {
      if (e instanceof PlayerError) return json(req, { error: e.message, code: e.code, retryAfter: e.retryAfter }, e.status);
      throw e;
    }
  }

  await rateLimit(userId, 'spotify', 20, 60);
  const body = SpotifyBody.parse(raw);

  if (body.action === 'authorize') {
    if (!allowedRedirect(req, body.redirectTo)) throw new HttpError(400, 'Redirect target not allowed', 'bad_redirect');
    const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const { error } = await serviceClient().from('oauth_states').insert({ state, user_id: userId, provider: 'spotify', code_verifier: verifier, redirect_to: body.redirectTo });
    if (error) throw new HttpError(500, error.message);
    const url = new URL('https://accounts.spotify.com/authorize');
    url.search = new URLSearchParams({ client_id: env('SPOTIFY_CLIENT_ID')!, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES, state, code_challenge_method: 'S256', code_challenge: challenge }).toString();
    return json(req, { url: url.toString() });
  }

  if (body.action === 'status') {
    const { data, error } = await serviceClient().from('oauth_tokens').select('scope, updated_at, external_user_id').eq('user_id', userId).eq('provider', 'spotify').maybeSingle();
    // Never report "not connected" because of a database hiccup: the player would drop to previews.
    if (error) throw new HttpError(503, 'Spotify link could not be read. Try again.', 'spotify_error');
    return json(req, { connected: !!data, scope: data?.scope ?? null, since: data?.updated_at ?? null, canPlay: !!data && canPlayWith(data.scope) });
  }

  if (body.action === 'disconnect') {
    await serviceClient().from('oauth_tokens').delete().eq('user_id', userId).eq('provider', 'spotify');
    return json(req, { connected: false });
  }

  // create-playlist
  const items = (await getItems(body.itemIds)).filter((i) => i.provider === 'spotify' && (i.kind === 'track' || i.kind === 'episode'));
  if (!items.length) throw new HttpError(400, 'Only Spotify tracks and episodes can be added to a Spotify playlist.', 'no_spotify_items');
  const token = await userToken(userId);
  const created = await fetch(`${API}/me/playlists`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: body.name, description: body.description ?? 'Curated with ECHO — discover beyond the algorithm.', public: false }),
  });
  if (!created.ok) {
    const msg = created.status === 403 ? 'Spotify refused: in Development Mode your Spotify account must be added to the app’s user allowlist.' : `Spotify error ${created.status}`;
    throw new HttpError(502, msg, 'spotify_error');
  }
  const pl = await created.json() as { id: string; external_urls: { spotify: string } };
  const add = await fetch(`${API}/playlists/${pl.id}/items`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: items.map((i) => `spotify:${i.kind}:${i.externalId}`) }),
  });
  if (!add.ok) throw new HttpError(502, `Playlist created but adding items failed (${add.status})`, 'spotify_error');
  return json(req, { playlistUrl: pl.external_urls.spotify, added: items.length });
});
