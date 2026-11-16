import { describe, expect, it } from 'vitest';
import { canPlayWith, IDLE_STATE, mapDevices, mapPlayerState, mapSpotifyError, pickDevice, PLAYABLE_URI, retryAfterSeconds, SCOPES, shuffleOffPath } from '../../../supabase/functions/spotify/player.ts';

// Synthetic Spotify-shaped payloads (no real catalog data).
const ID = 'A'.repeat(22);

describe('scopes', () => {
  it('requests playlist and playback permissions', () => {
    for (const s of ['playlist-modify-private', 'playlist-modify-public', 'user-modify-playback-state', 'user-read-playback-state', 'user-read-currently-playing']) expect(SCOPES.split(' ')).toContain(s);
  });

  it('canPlay needs user-modify-playback-state', () => {
    expect(canPlayWith('playlist-modify-private playlist-modify-public')).toBe(false);
    expect(canPlayWith('playlist-modify-private user-modify-playback-state')).toBe(true);
    expect(canPlayWith(null)).toBe(false);
  });

  it('only queues track and episode URIs', () => {
    expect(PLAYABLE_URI.test(`spotify:track:${ID}`)).toBe(true);
    expect(PLAYABLE_URI.test(`spotify:episode:${ID}`)).toBe(true);
    expect(PLAYABLE_URI.test(`spotify:album:${ID}`)).toBe(false);
    expect(PLAYABLE_URI.test('spotify:track:abc')).toBe(false);
  });
});

describe('mapSpotifyError', () => {
  it('maps no active device', () => {
    expect(mapSpotifyError(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } })).toMatchObject({ code: 'no_device', status: 409 });
  });

  it('maps Premium required', () => {
    expect(mapSpotifyError(403, { error: { status: 403, message: 'Player command failed: Premium required', reason: 'PREMIUM_REQUIRED' } })).toMatchObject({ code: 'premium_required', status: 403 });
  });

  it('asks to reconnect on 401 without answering 401 (which would sign the user out of ECHO)', () => {
    const e = mapSpotifyError(401, { error: { status: 401, message: 'The access token expired' } });
    expect(e.code).toBe('reconnect');
    expect(e.status).not.toBe(401);
  });

  it('asks to reconnect when a permission is missing', () => {
    expect(mapSpotifyError(403, { error: { status: 403, message: 'Insufficient client scope' } }).code).toBe('reconnect');
  });

  it('treats other player restrictions as non-fatal', () => {
    expect(mapSpotifyError(403, { error: { status: 403, message: 'Player command failed: Restriction violated', reason: 'RESTRICTION_VIOLATED' } }).code).toBe('restricted');
  });

  it('explains a bare 403 (Development Mode allowlist)', () => {
    expect(mapSpotifyError(403, null).code).toBe('spotify_forbidden');
  });

  it('passes rate limits through with Retry-After', () => {
    expect(mapSpotifyError(429, null, '7')).toMatchObject({ code: 'rate_limited', status: 429, retryAfter: 7 });
    expect(mapSpotifyError(429, null, null).retryAfter).toBeGreaterThan(0);
  });

  it('maps anything else to a generic upstream error', () => {
    expect(mapSpotifyError(500, null)).toMatchObject({ code: 'spotify_error', status: 502 });
  });

  it('parses Retry-After seconds and dates, bounded to a day', () => {
    expect(retryAfterSeconds('12')).toBe(12);
    expect(retryAfterSeconds('999999')).toBe(86400);
    expect(retryAfterSeconds(new Date(30_000).toUTCString(), 0)).toBe(30);
    expect(retryAfterSeconds('soon', 0, 4)).toBe(4);
  });
});

describe('devices', () => {
  const raw = {
    devices: [
      { id: 'tv1', is_active: false, is_restricted: false, name: 'Living room', type: 'TV' },
      { id: 'pc1', is_active: false, is_restricted: false, name: 'Laptop', type: 'Computer' },
      { id: 'ph1', is_active: false, is_restricted: false, name: 'Phone', type: 'Smartphone' },
      { id: 'sp1', is_active: false, is_restricted: true, name: 'Speaker', type: 'Speaker' },
    ],
  };

  it('prefers the active device', () => {
    const list = mapDevices({ devices: [...raw.devices, { id: 'tv2', is_active: true, is_restricted: false, name: 'Other TV', type: 'TV' }] });
    expect(pickDevice(list)?.id).toBe('tv2');
  });

  it('then a smartphone, then a computer', () => {
    expect(pickDevice(mapDevices(raw))?.id).toBe('ph1');
    expect(pickDevice(mapDevices({ devices: raw.devices.filter((d) => d.id !== 'ph1') }))?.id).toBe('pc1');
  });

  it('never picks a restricted device or one without an id', () => {
    expect(pickDevice(mapDevices({ devices: [raw.devices[3], { id: null, is_active: true, name: 'Ghost', type: 'Smartphone' }] }))).toBeNull();
    expect(pickDevice(mapDevices({}))).toBeNull();
  });
});

describe('mapPlayerState', () => {
  it('maps nothing playing (204) to an idle state', () => {
    expect(mapPlayerState(null)).toEqual(IDLE_STATE);
  });

  it('maps a playing track', () => {
    const s = mapPlayerState({
      is_playing: true,
      progress_ms: 61_000,
      device: { id: 'ph1', name: 'Phone', type: 'Smartphone', is_active: true },
      item: {
        uri: `spotify:track:${ID}`, id: ID, name: 'Synthetic Song', duration_ms: 210_000,
        artists: [{ name: 'Artist One' }, { name: 'Artist Two' }],
        album: { images: [{ url: 'https://i.example/640', width: 640 }, { url: 'https://i.example/300', width: 300 }, { url: 'https://i.example/64', width: 64 }] },
      },
    });
    expect(s).toEqual({
      isPlaying: true, progressMs: 61_000, durationMs: 210_000, shuffle: false,
      device: { id: 'ph1', name: 'Phone', type: 'Smartphone' },
      track: { uri: `spotify:track:${ID}`, id: ID, name: 'Synthetic Song', artists: ['Artist One', 'Artist Two'], artworkUrl: 'https://i.example/300' },
    });
  });

  it('maps an episode using its show', () => {
    const s = mapPlayerState({ is_playing: false, progress_ms: 5, item: { uri: `spotify:episode:${ID}`, name: 'Episode', duration_ms: 1000, images: [{ url: 'https://i.example/e', width: 640 }], show: { name: 'Show' } } });
    expect(s.track).toMatchObject({ artists: ['Show'], artworkUrl: 'https://i.example/e' });
    expect(s.device).toBeNull();
  });

  it('reports Spotify’s shuffle setting (it would scramble a lane)', () => {
    expect(mapPlayerState({ is_playing: true, shuffle_state: true, item: null }).shuffle).toBe(true);
    expect(mapPlayerState({ is_playing: true, shuffle_state: false, item: null }).shuffle).toBe(false);
    expect(mapPlayerState({ is_playing: true, item: null }).shuffle).toBe(false);
  });

  it('survives ads and odd payloads', () => {
    expect(mapPlayerState({ is_playing: true, item: null, currently_playing_type: 'ad' }).track).toBeNull();
    expect(mapPlayerState('nope')).toEqual(IDLE_STATE);
  });
});

describe('shuffleOffPath', () => {
  it('turns shuffle off on the given device, else on the active one', () => {
    expect(shuffleOffPath()).toBe('/me/player/shuffle?state=false');
    expect(shuffleOffPath(null)).toBe('/me/player/shuffle?state=false');
    expect(shuffleOffPath('ph 1')).toBe('/me/player/shuffle?state=false&device_id=ph%201');
  });
});
