// Spotify user authorization (Authorization Code + PKCE) and playlist creation.
//   POST { action: 'authorize', redirectTo }  → { url }   (user then consents on accounts.spotify.com)
//   GET  ?code&state                          → OAuth callback, stores tokens server-side, redirects back to the app
//   POST { action: 'status' | 'disconnect' | 'create-playlist' }
// Tokens are stored in public.oauth_tokens, which is unreadable from the browser (RLS + revoked privileges).
// Uses the Feb-2026 endpoints: POST /v1/me/playlists and POST /v1/playlists/{id}/items.
import { SpotifyBody } from '../_shared/schemas.ts';
import { env, getItems, HttpError, json, rateLimit, readJson, requireUser, serve, serviceClient } from '../_shared/server.ts';

const SCOPES = 'playlist-modify-private playlist-modify-public';

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
  if (!res.ok) throw new HttpError(502, `Spotify token exchange failed (${res.status})`, 'spotify_error');
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

async function userToken(userId: string): Promise<string> {
  const { data } = await serviceClient().from('oauth_tokens').select('*').eq('user_id', userId).eq('provider', 'spotify').maybeSingle();
  if (!data) throw new HttpError(409, 'Connect Spotify first (Settings → Connected platforms).', 'spotify_not_connected');
  if (new Date(data.expires_at).getTime() - 60_000 > Date.now()) return data.access_token;
  if (!data.refresh_token) throw new HttpError(409, 'Spotify session expired. Please reconnect.', 'spotify_not_connected');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: data.refresh_token });
  await serviceClient().from('oauth_tokens').update({
    access_token: t.access_token, refresh_token: t.refresh_token ?? data.refresh_token, expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('provider', 'spotify');
  return t.access_token;
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
    const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${t.access_token}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    await serviceClient().from('oauth_tokens').upsert({
      user_id: st.user_id, provider: 'spotify', access_token: t.access_token, refresh_token: t.refresh_token ?? null, scope: t.scope ?? SCOPES,
      expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(), external_user_id: me?.id ?? null, updated_at: new Date().toISOString(),
    });
    back.searchParams.set('spotify', 'connected');
    return Response.redirect(back.toString(), 302);
  }

  const { userId } = await requireUser(req);
  await rateLimit(userId, 'spotify', 20, 60);
  const body = SpotifyBody.parse(await readJson(req));

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
    const { data } = await serviceClient().from('oauth_tokens').select('scope, updated_at, external_user_id').eq('user_id', userId).eq('provider', 'spotify').maybeSingle();
    return json(req, { connected: !!data, scope: data?.scope ?? null, since: data?.updated_at ?? null });
  }

  if (body.action === 'disconnect') {
    await serviceClient().from('oauth_tokens').delete().eq('user_id', userId).eq('provider', 'spotify');
    return json(req, { connected: false });
  }

  // create-playlist
  const items = (await getItems(body.itemIds)).filter((i) => i.provider === 'spotify' && (i.kind === 'track' || i.kind === 'episode'));
  if (!items.length) throw new HttpError(400, 'Only Spotify tracks and episodes can be added to a Spotify playlist.', 'no_spotify_items');
  const token = await userToken(userId);
  const created = await fetch('https://api.spotify.com/v1/me/playlists', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: body.name, description: body.description ?? 'Curated with ECHO — discover beyond the algorithm.', public: false }),
  });
  if (!created.ok) {
    const msg = created.status === 403 ? 'Spotify refused: in Development Mode your Spotify account must be added to the app’s user allowlist.' : `Spotify error ${created.status}`;
    throw new HttpError(502, msg, 'spotify_error');
  }
  const pl = await created.json() as { id: string; external_urls: { spotify: string } };
  const add = await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/items`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: items.map((i) => `spotify:${i.kind}:${i.externalId}`) }),
  });
  if (!add.ok) throw new HttpError(502, `Playlist created but adding items failed (${add.status})`, 'spotify_error');
  return json(req, { playlistUrl: pl.external_urls.spotify, added: items.length });
});
