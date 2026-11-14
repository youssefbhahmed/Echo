// Local Edge Functions router: runs every function in ONE Deno process on the host.
// Useful without Docker, or where the Docker edge runtime cannot fetch npm packages.
//   deno run -A --env-file=supabase/functions/.env scripts/dev-functions.ts
// Serves http://127.0.0.1:54331/functions/v1/<name>  (set VITE_FUNCTIONS_URL to use it).
const NAMES = ['discover', 'chat', 'feedback', 'profile', 'catalog', 'account', 'spotify', 'health'];
const handlers = new Map<string, (req: Request) => Promise<Response>>();
let pending: string | null = null;
// deno-lint-ignore no-explicit-any
(globalThis as any).__ECHO_ROUTER__ = (h: (req: Request) => Promise<Response>) => {
  if (pending) handlers.set(pending, h);
};
for (const name of NAMES) {
  pending = name;
  await import(`../supabase/functions/${name}/index.ts`);
}
pending = null;
const port = Number(Deno.env.get('ECHO_FUNCTIONS_PORT') ?? 54331);
Deno.serve({ port, hostname: '127.0.0.1' }, (req) => {
  const m = /^\/functions\/v1\/([a-z-]+)/.exec(new URL(req.url).pathname);
  const h = m && handlers.get(m[1]);
  if (!h) return new Response('Not found', { status: 404 });
  return h(req);
});
console.log(`ECHO functions: ${[...handlers.keys()].join(', ')} on http://127.0.0.1:${port}/functions/v1/`);
