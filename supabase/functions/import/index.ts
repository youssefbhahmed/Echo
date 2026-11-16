// POST /functions/v1/import — import the user's own Spotify Liked Songs (parsed from an Exportify CSV in the browser).
import { z } from 'npm:zod@4.6.7';
import { analyzeLibrary, applyLibraryImport, topStyles, trackToItem } from '../_shared/importer.ts';
import { HttpError, json, loadProfile, rateLimit, readJson, requireUser, saveProfile, serve, upsertItems } from '../_shared/server.ts';

const unit = z.number().min(0).max(1).optional();
const Track = z.object({
  id: z.string().regex(/^[A-Za-z0-9]{22}$/),
  name: z.string().min(1).max(300),
  album: z.string().max(300).optional(),
  artists: z.array(z.string().max(200)).max(6),
  releaseDate: z.string().max(20).optional(),
  durationMs: z.number().int().min(0).max(36_000_000).optional(),
  genres: z.array(z.string().max(60)).max(12),
  valence: unit,
  energy: unit,
  danceability: unit,
  acousticness: unit,
  speechiness: unit,
  instrumentalness: unit,
  tempo: z.number().min(0).max(300).optional(),
  loudness: z.number().min(-80).max(10).optional(),
  popularity: z.number().min(0).max(100).optional(),
  addedAt: z.string().max(40).optional(),
  isrc: z.string().regex(/^[A-Za-z0-9-]{12,15}$/).optional(),
});
const Body = z.object({ source: z.literal('spotify-liked-csv'), tracks: z.array(Track).min(1).max(5000) });

serve(async (req) => {
  const { userId, db } = await requireUser(req);
  await rateLimit(userId, 'import', 3, 300);
  const body = Body.parse(await readJson(req, 4_000_000));

  const items = body.tracks.map(trackToItem);
  await upsertItems(items);

  // Library: every imported song is a "loved" item (keeps existing saves/ratings).
  for (let i = 0; i < items.length; i += 500) {
    const rows = items.slice(i, i + 500).map((it) => ({ user_id: userId, item_id: it.id, liked: true }));
    const { error } = await db.from('library_items').upsert(rows, { onConflict: 'user_id,item_id' });
    if (error) throw new HttpError(500, `Library import failed: ${error.message}`);
  }
  for (let i = 0; i < items.length; i += 500) {
    const rows = items.slice(i, i + 500).map((it) => ({ user_id: userId, item_id: it.id, type: 'like', context: { source: 'import' } }));
    await db.from('interactions').insert(rows);
  }

  const before = await loadProfile(db, userId);
  const now = new Date();
  // Taste lanes (kNN for untagged songs, owner policy) + music DNA, from generic features only.
  const { dna, inferredGenres } = analyzeLibrary(body.tracks, now);
  let profile = applyLibraryImport(before, items, body.tracks.map((t) => t.addedAt), now, { inferredGenres });
  // Breadth listeners (almost every song by a different artist) get a more exploratory default.
  const eclectic = dna.distinctArtists / Math.max(1, dna.tracks) > 0.8;
  profile = { ...profile, music: dna, exploration: eclectic ? Math.max(profile.exploration, 0.55) : profile.exploration };
  await saveProfile(db, userId, profile);

  const artistCounts = new Map<string, number>();
  for (const t of body.tracks) for (const a of t.artists) artistCounts.set(a, (artistCounts.get(a) ?? 0) + 1);
  return json(req, {
    imported: items.length,
    dna,
    lanes: (dna.lanes ?? []).map((l) => ({ id: l.id, label: l.label, share: l.share })),
    topStyles: topStyles(profile, 10),
    topArtists: [...artistCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([a]) => a),
  });
});
