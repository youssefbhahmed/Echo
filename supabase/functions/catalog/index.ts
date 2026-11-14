// POST /functions/v1/catalog — lookup (onboarding pickers), trailer (TMDB → YouTube embed), refresh (YouTube 30-day policy).
import { analyzeItem } from '../_shared/engine/analyze.ts';
import { createHttp } from '../_shared/providers/http.ts';
import { providersFor } from '../_shared/providers/index.ts';
import { tmdbTrailer } from '../_shared/providers/tmdb.ts';
import { refreshYouTube } from '../_shared/providers/youtube.ts';
import { CatalogBody } from '../_shared/schemas.ts';
import type { Category, ContentItem } from '../_shared/types.ts';
import { DbCache, env, getItems, HttpError, json, rateLimit, readJson, requireUser, serve, upsertItems } from '../_shared/server.ts';

serve(async (req) => {
  const { userId } = await requireUser(req);
  await rateLimit(userId, 'catalog', 40, 60);
  const body = CatalogBody.parse(await readJson(req));
  const http = createHttp(new DbCache());
  const ctx = { http, env };

  if (body.action === 'lookup') {
    const cats: Category[] = body.category ? [body.category] : ['screen', 'music', 'books'];
    const results: ContentItem[] = [];
    await Promise.all(cats.map(async (c) => {
      for (const p of providersFor(c, env).slice(0, 1)) {
        try {
          const items = await p.search({ query: body.query, category: c, limit: 6 }, ctx);
          results.push(...items.slice(0, body.category ? 8 : 4));
        } catch (e) {
          console.error('[echo] lookup failed', p.id, (e as Error).message);
        }
      }
    }));
    const analyzed = results.map(analyzeItem);
    await upsertItems(analyzed);
    return json(req, { items: analyzed.map((i) => ({ ...i, embedding: undefined })) });
  }

  if (body.action === 'trailer') {
    const [item] = await getItems([body.itemId]);
    if (!item || item.provider !== 'tmdb') throw new HttpError(404, 'Trailers are available for TMDB titles only', 'not_found');
    const videoId = await tmdbTrailer(item.externalId, ctx).catch(() => null);
    return json(req, { videoId });
  }

  if (body.action === 'refresh') {
    const items = await getItems(body.itemIds);
    const stale = items.filter((i) => i.provider === 'youtube' && (i.metadata?.stale || Date.now() - new Date(String(i.metadata?.fetchedAt ?? 0)).getTime() > 25 * 86400_000));
    const fresh = (await refreshYouTube(stale.map((i) => i.externalId), ctx).catch(() => [])).map(analyzeItem);
    await upsertItems(fresh);
    return json(req, { refreshed: fresh.length });
  }

  const items = await getItems(body.itemIds);
  return json(req, { items: items.map((i) => ({ ...i, embedding: undefined })) });
});
