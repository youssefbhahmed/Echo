// Live smoke test of the recommendation pipeline against real provider APIs.
// Usage: deno run -A scripts/smoke-pipeline.ts "your request" [categories,comma,separated]
// Uses whatever provider keys are present in the environment (keyless providers always work).
import { runPipeline } from '../supabase/functions/_shared/engine/pipeline.ts';
import { createHttp, MemoryCache } from '../supabase/functions/_shared/providers/http.ts';
import { emptyProfile } from '../supabase/functions/_shared/engine/profile.ts';
import type { Category } from '../supabase/functions/_shared/types.ts';

const query = Deno.args[0] ?? '';
const categories = Deno.args[1] ? (Deno.args[1].split(',') as Category[]) : undefined;
const http = createHttp(new MemoryCache());
const res = await runPipeline({ query, categories, limit: 8 }, { env: (n) => Deno.env.get(n), http, profile: emptyProfile() });
console.log('INTENT:', JSON.stringify({ intent: res.intent.intent, cats: res.intent.categories, target: res.intent.target, refs: res.intent.references, traj: res.intent.trajectory, kw: res.intent.keywords }));
console.log('PIPELINE:', res.pipeline.map((p) => `${p.step}(${p.ms}ms): ${p.detail ?? ''}`).join('\n  '));
console.log('PROVIDERS:', JSON.stringify(res.providers));
console.log('REPLY:', res.reply);
for (const r of res.recommendations) console.log(`- [${r.item.category}/${r.item.provider}] ${r.item.title} — ${r.item.creators.join(', ')} | ${r.score.total} | ${r.explanation.text}`);
