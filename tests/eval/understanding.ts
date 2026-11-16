// Live evaluation of request understanding (rules vs AI-first). Requires AI_* env vars.
//   deno run -A --env-file=<env> tests/eval/understanding.ts
import { parseIntent, refineIntent } from '../../supabase/functions/_shared/engine/intent.ts';
import { applyUnderstanding, llmUnderstand } from '../../supabase/functions/_shared/engine/understand.ts';
import { aiConfig } from '../../supabase/functions/_shared/engine/ai.ts';
import { createHttp, MemoryCache } from '../../supabase/functions/_shared/providers/http.ts';
import type { Intent } from '../../supabase/functions/_shared/types.ts';

type Case = { q: string; prev?: string; expect: (i: Intent) => string | null };
const has = (i: Intent, c: string) => i.categories.includes(c as never);
const only = (i: Intent, ...c: string[]) => i.categories.length === c.length && c.every((x) => has(i, x));
const CASES: Case[] = [
  { q: 'youtube podcasts', expect: (i) => (only(i, 'podcasts') && i.providers?.includes('youtube') ? null : 'want podcasts from youtube') },
  { q: 'des podcasts youtube sur la géopolitique', expect: (i) => (only(i, 'podcasts') && i.providers?.includes('youtube') && (i.target.politics ?? 0) > 0 ? null : 'podcasts/youtube/politics') },
  { q: 'spotify podcasts about history', expect: (i) => (only(i, 'podcasts') && i.providers?.includes('spotify') ? null : 'podcasts from spotify') },
  { q: 'je veux de la musique triste mais pas de pop française', expect: (i) => (only(i, 'music') && (i.target.melancholic ?? 0) > 0 && i.excludes.some((x) => /french|fran/.test(x)) ? null : 'music, sad, exclude french pop') },
  { q: 'un bon film de science-fiction pas trop long', expect: (i) => (only(i, 'screen') && (i.target['sci-fi'] ?? 0) > 0 && i.duration ? null : 'screen, sci-fi, duration') },
  { q: 'des documentaires sérieux sur les origines de la civilisation', expect: (i) => (has(i, 'screen') || has(i, 'youtube')) && (i.target.civilization ?? 0) > 0 ? null : 'docs on civilization' },
  { q: "Something with the same existential feeling as Interstellar, but it doesn't have to be science fiction", expect: (i) => (i.references.includes('Interstellar') && !(i.target['sci-fi'] > 0) && (i.target.existential ?? 0) > 0 ? null : 'ref + relaxed sci-fi') },
  { q: "I'm feeling nostalgic. Recommend music that starts melancholic and gradually becomes uplifting.", expect: (i) => (only(i, 'music') && i.trajectory?.from === 'melancholic' && i.trajectory?.to === 'uplifting' ? null : 'music trajectory') },
  { q: 'Find music that feels like watching the sunrise after a difficult night.', expect: (i) => (only(i, 'music') && !i.references.length ? null : 'music, no reference') },
  { q: 'surprise me with something completely outside my comfort zone', expect: (i) => ((i.exploration ?? 0) >= 0.8 ? null : 'high exploration') },
  { q: 'no motivational speeches for the videos', expect: (i) => (only(i, 'youtube') && i.excludes.some((x) => /motivat/.test(x)) ? null : 'videos excluding motivational') },
  { q: 'video essays about cinema', expect: (i) => (has(i, 'youtube') && !has(i, 'books') ? null : 'videos not books') },
  { q: 'a book like Dune', expect: (i) => (only(i, 'books') && i.references.some((r) => /dune/i.test(r)) ? null : 'books, ref Dune') },
  { q: 'rap marocain récent', expect: (i) => (only(i, 'music') ? null : 'music') },
  { q: 'stuff to fall asleep to', expect: (i) => ((i.target.calm ?? 0) > 0 || i.energy === 'low' ? null : 'calm') },
  { q: 'interviews with scientists about consciousness', expect: (i) => ((has(i, 'podcasts') || has(i, 'youtube')) && ((i.target.psychology ?? 0) > 0 || (i.target.science ?? 0) > 0) ? null : 'podcasts/videos on consciousness') },
  { q: 'I hate true crime, give me history podcasts', expect: (i) => (only(i, 'podcasts') && (i.target.history ?? 0) > 0 && i.statements.some((s) => s.polarity === -1) ? null : 'podcasts, history, remember dislike') },
  { q: 'something to watch tonight with friends, funny', expect: (i) => ((has(i, 'screen') || has(i, 'youtube')) && (i.target.humor ?? 0) > 0 ? null : 'screen + humor') },
  { q: 'musique gnawa moderne', expect: (i) => (only(i, 'music') ? null : 'music') },
  { q: 'livres de philosophie accessibles', expect: (i) => (only(i, 'books') && (i.target.philosophy ?? 0) > 0 ? null : 'books philosophy') },
  { q: 'only books', prev: 'dark atmospheric sci-fi films', expect: (i) => (only(i, 'books') && (i.target['sci-fi'] ?? 0) > 0 ? null : 'books keeping sci-fi') },
  { q: 'less dark', prev: 'dark atmospheric sci-fi films', expect: (i) => ((i.target.dark ?? 0) <= 0 && has(i, 'screen') ? null : 'less dark, still films') },
  { q: 'plutôt en français', prev: 'podcasts about stoicism', expect: (i) => (i.language === 'fr' && has(i, 'podcasts') ? null : 'french language, podcasts') },
  { q: "they're bad", prev: 'youtube podcasts about business', expect: (i) => (!i.keywords.some((k) => /bad|they/.test(k)) ? null : 'no garbage keywords') },
  { q: 'only the youtube ones', prev: 'podcasts about stoicism', expect: (i) => (has(i, 'podcasts') && i.providers?.includes('youtube') ? null : 'podcasts from youtube') },
  { q: 'Radiohead vibes but more electronic', expect: (i) => (has(i, 'music') && i.references.some((r) => /radiohead/i.test(r)) ? null : 'music, ref Radiohead') },
  { q: 'série coréenne à suspense', expect: (i) => (only(i, 'screen') && (i.target.tense ?? 0) > 0 ? null : 'screen, tense') },
  { q: 'long YouTube documentaries about the Ottoman empire', expect: (i) => (only(i, 'youtube') && i.duration === 'long' && (i.target.history ?? 0) > 0 ? null : 'youtube long history') },
  { q: 'music for running', expect: (i) => (only(i, 'music') && ((i.target.energetic ?? 0) > 0 || i.energy === 'high') ? null : 'energetic music') },
  { q: 'hmm', expect: (i) => (i.vague ? null : 'vague') },
];

const ai = aiConfig((n) => Deno.env.get(n));
const http = createHttp(new MemoryCache());
let rulesOk = 0;
let aiOk = 0;
const PACE = Number(Deno.env.get('EVAL_PACE_MS') ?? 0);
for (const c of CASES) {
  if (PACE) await new Promise((r) => setTimeout(r, PACE));
  const prev = c.prev ? parseIntent(c.prev) : null;
  const r0 = parseIntent(c.q);
  const rules = prev ? refineIntent(prev, r0) : r0;
  const rErr = c.expect(rules);
  let aErr: string | null = 'no AI';
  let ai_i: Intent | null = null;
  if (ai) {
    try {
      ai_i = applyUnderstanding(r0, await llmUnderstand(c.q, prev, ai, http), prev);
      aErr = c.expect(ai_i);
    } catch (e) {
      aErr = `error ${(e as Error).message.slice(0, 60)}`;
    }
  }
  if (!rErr) rulesOk++;
  if (!aErr) aiOk++;
  console.log(`${rErr ? '✗' : '✓'} rules  ${aErr ? '✗' : '✓'} AI  | ${c.prev ? `[after "${c.prev}"] ` : ''}${c.q}`);
  if (aErr && !ai_i) console.log('      AI error: ' + aErr);
  if (aErr && ai_i) console.log(`      AI miss: ${aErr} :: cats=${ai_i.categories} prov=${ai_i.providers ?? ''} search=${JSON.stringify(ai_i.searchQueries ?? {})} excl=${ai_i.excludes} lang=${ai_i.language ?? ''} dur=${ai_i.duration ?? ''} traj=${JSON.stringify(ai_i.trajectory ?? null)} t=${JSON.stringify(ai_i.target)}`);
}
console.log(`\nRULES ${rulesOk}/${CASES.length}   AI-FIRST ${aiOk}/${CASES.length}`);
