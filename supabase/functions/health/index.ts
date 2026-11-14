// GET /functions/v1/health — public, secret-free server capability report.
import { aiConfig } from '../_shared/engine/ai.ts';
import { providerStatus } from '../_shared/providers/index.ts';
import { env, json, serve } from '../_shared/server.ts';

serve((req) => Promise.resolve(json(req, {
  ok: true,
  service: 'echo',
  version: '0.1.0',
  providers: providerStatus(env).map(({ id, label, configured, categories }) => ({ id, label, configured, categories })),
  ai: !!aiConfig(env),
  embeddings: env('ECHO_EMBEDDINGS') === 'on',
  spotifyOAuth: !!(env('SPOTIFY_CLIENT_ID') && env('SPOTIFY_CLIENT_SECRET')),
})));
