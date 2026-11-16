import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Ban, Pin, Plus, Trash2, TrendingUp, X } from 'lucide-react';
import { CATEGORIES, type Category } from '@shared/types.ts';
import { CONCEPT_BY_ID, CONCEPTS, conceptLabel } from '@shared/engine/concepts.ts';
import type { ProfileEdit } from '@shared/engine/profile.ts';
import { api, type ProfileResponse } from '../lib/api';
import { useProfile } from '../hooks/data';
import { CATEGORY_META } from '../lib/meta';
import { PageHeader } from '../components/Shell';
import { Listening } from '../components/Echo';
import { toast } from '../components/Toast';

const ANGLE: Record<Category, number> = { youtube: -90, music: -18, screen: 54, books: 126, podcasts: 198 };

/** Concepts are placed toward the categories where they were learned; shared concepts sit between them. */
function Constellation({ data }: { data: ProfileResponse }) {
  const { model } = data;
  const nodes = useMemo(() => {
    const top = Object.entries(model.concepts).filter(([k, w]) => w > 0.15 && CONCEPT_BY_ID[k]).sort((a, b) => b[1] - a[1]).slice(0, 16);
    const max = top[0]?.[1] ?? 1;
    const placed = top.map(([id, w], i) => {
      let x = 0;
      let y = 0;
      let total = 0;
      const cats: Category[] = [];
      for (const c of CATEGORIES) {
        const cw = model.conceptsByCategory[c]?.[id] ?? 0;
        if (cw > 0.1) {
          const a = (ANGLE[c] * Math.PI) / 180;
          x += Math.cos(a) * cw;
          y += Math.sin(a) * cw;
          total += cw;
          cats.push(c);
        }
      }
      let angle = total ? Math.atan2(y, x) : ((i * 137.5) * Math.PI) / 180; // golden-angle spread for declared-only interests
      if (total && Math.hypot(x, y) / total < 0.15) angle = ((i * 137.5) * Math.PI) / 180;
      const strength = w / max;
      const r = 48 + (1 - strength) * 92;
      return { id, w, cats, x: 180 + Math.cos(angle) * r, y: 180 + Math.sin(angle) * r, size: 4 + strength * 9 };
    });
    // Simple collision relaxation so labels stay readable; keeps nodes inside the orbit.
    for (let iter = 0; iter < 80; iter++) {
      for (let a = 0; a < placed.length; a++) {
        for (let b = a + 1; b < placed.length; b++) {
          const A = placed[a];
          const B = placed[b];
          const dx = B.x - A.x;
          const dy = B.y - A.y;
          const d = Math.hypot(dx, dy) || 0.01;
          const min = A.size + B.size + 22;
          if (d < min) {
            const push = (min - d) / 2;
            A.x -= (dx / d) * push; A.y -= (dy / d) * push;
            B.x += (dx / d) * push; B.y += (dy / d) * push;
          }
        }
      }
      for (const n of placed) {
        const dx = n.x - 180;
        const dy = n.y - 180;
        const d = Math.hypot(dx, dy);
        if (d > 140) { n.x = 180 + (dx / d) * 140; n.y = 180 + (dy / d) * 140; }
      }
    }
    return placed;
  }, [model]);

  if (!nodes.length)
    return <p className="rounded-2xl border border-line bg-ink-2/60 p-6 text-sm text-mist">Your constellation appears as you like, save and rate things. Every interaction adds a star.</p>;

  return (
    <figure className="relative mx-auto aspect-square w-full max-w-[460px]">
      <svg viewBox="-24 -8 408 380" className="h-full w-full" role="img" aria-label="Taste constellation: themes and moods placed toward the media where you enjoy them">
        {[60, 110, 160].map((r) => <circle key={r} cx="180" cy="180" r={r} fill="none" stroke="rgba(255,255,255,0.05)" />)}
        {CATEGORIES.map((c) => {
          const a = (ANGLE[c] * Math.PI) / 180;
          const ax = 180 + Math.cos(a) * 166;
          const ay = 180 + Math.sin(a) * 166;
          return (
            <g key={c}>
              {nodes.filter((n) => n.cats.includes(c)).map((n) => (
                <line key={n.id} x1={n.x} y1={n.y} x2={ax} y2={ay} stroke={CATEGORY_META[c].color} strokeOpacity={0.18} strokeWidth={1} />
              ))}
              <circle cx={ax} cy={ay} r={9} fill="var(--color-ink-3)" stroke={CATEGORY_META[c].color} strokeWidth={1.5} />
              <text x={ax} y={ay + (ay > 180 ? 22 : -14)} textAnchor="middle" fontSize="9.5" fill={CATEGORY_META[c].color} style={{ letterSpacing: '0.08em' }}>{CATEGORY_META[c].label.toUpperCase()}</text>
            </g>
          );
        })}
        {nodes.map((n, i) => {
          const def = CONCEPT_BY_ID[n.id];
          const color = def.group === 'mood' ? 'var(--color-iris)' : def.group === 'quality' ? 'var(--color-tide)' : 'var(--color-ember)';
          return (
            <motion.g key={n.id} initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: i * 0.04, duration: 0.5 }} style={{ transformOrigin: `${n.x}px ${n.y}px` }}>
              <circle cx={n.x} cy={n.y} r={n.size + 5} fill={color} opacity={0.12} />
              <circle cx={n.x} cy={n.y} r={n.size} fill={color} />
              <text x={n.x} y={n.y + n.size + 11} textAnchor="middle" fontSize="9.5" fill="var(--color-bone)">{conceptLabel(n.id).split(' & ')[0]}</text>
            </motion.g>
          );
        })}
        <circle cx="180" cy="180" r="5" fill="var(--color-bone)" />
      </svg>
      <figcaption className="mt-2 text-center text-xs text-dim">
        <span className="text-ember">●</span> themes · <span className="text-iris">●</span> moods · <span className="text-tide">●</span> qualities. Closer to the centre means stronger. Lines show where you’ve enjoyed each one.
      </figcaption>
    </figure>
  );
}

function WeightRow({ id, weight, max, onEdit, pinned }: { id: string; weight: number; max: number; onEdit: (e: ProfileEdit) => void; pinned: boolean }) {
  return (
    <li className="group flex items-center gap-3 py-1.5">
      <span className="w-40 shrink-0 truncate text-sm">{conceptLabel(id)}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-4">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-ember-deep to-ember" initial={{ width: 0 }} animate={{ width: `${Math.max(4, (weight / max) * 100)}%` }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} />
      </div>
      <div className="flex gap-0.5 opacity-70 group-hover:opacity-100">
        <button type="button" title={pinned ? 'Unpin' : 'Pin: always consider this'} aria-label={`${pinned ? 'Unpin' : 'Pin'} ${conceptLabel(id)}`} onClick={() => onEdit(pinned ? { unpinConcept: id } : { pinConcept: id })} className={`rounded-lg p-1.5 hover:bg-ink-3 ${pinned ? 'text-ember' : 'text-dim'}`}><Pin className="h-3.5 w-3.5" /></button>
        <button type="button" title="Avoid this" aria-label={`Avoid ${conceptLabel(id)}`} onClick={() => onEdit({ blockConcept: id })} className="rounded-lg p-1.5 text-dim hover:bg-ink-3 hover:text-danger"><Ban className="h-3.5 w-3.5" /></button>
        <button type="button" title="Forget" aria-label={`Forget ${conceptLabel(id)}`} onClick={() => onEdit({ removeConcept: id })} className="rounded-lg p-1.5 text-dim hover:bg-ink-3 hover:text-bone"><X className="h-3.5 w-3.5" /></button>
      </div>
    </li>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-line bg-ink-2/70 p-5">
      <h2 className="font-display text-xl">{title}</h2>
      {hint && <p className="mt-0.5 text-xs text-dim">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function Taste() {
  const { data, isLoading, error } = useProfile();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const edit = async (e: ProfileEdit) => {
    try {
      await api.editProfile(e);
      await qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['feed'] });
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  if (isLoading) return <Listening label="Reading your constellation…" />;
  if (error || !data) return <p className="p-8 text-danger">{(error as Error)?.message ?? 'Could not load your profile.'}</p>;
  const { insights, model } = data;
  const maxTheme = Math.max(0.01, ...insights.themes.map((t) => t.weight), ...insights.moods.map((t) => t.weight));
  const confidence = { none: 'Just getting to know you', low: 'Early impressions', medium: 'Taking shape', high: 'Well understood' }[insights.confidence];

  return (
    <div>
      <PageHeader eyebrow="My Taste" title={<>Your <span className="text-mist italic">constellation</span></>}>
        <p className="text-sm text-mist">{confidence} · {model.interactionCount} signals</p>
      </PageHeader>
      <div className="mt-6 grid gap-4 px-4 md:px-8 lg:grid-cols-2">
        <div className="lg:row-span-2">
          <Section title="Constellation" hint="Patterns in what you’ve told ECHO and how you’ve reacted. Not judgments about who you are.">
            <Constellation data={data} />
          </Section>
        </div>

        {model.music && (
          <Section title="Music DNA" hint={`From your ${model.music.tracks} imported Spotify liked songs`}>
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap gap-1.5">{model.music.styles.slice(0, 12).map((g) => <span key={g} className="rounded-full bg-ink-3 px-2.5 py-1 capitalize">{g}</span>)}</div>
              {model.music.recentStyles.length > 0 && <p><span className="text-dim">Lately drifting toward </span>{model.music.recentStyles.slice(0, 6).join(', ')}</p>}
              <p><span className="text-dim">Mostly </span>{model.music.decades.join(', ')}<span className="text-dim"> · in </span>{model.music.languages.join(', ')}</p>
              <p><span className="text-dim">Mood: </span>often {model.music.mood.topQuadrant} · danceability {Math.round(model.music.mood.danceability * 100)}%</p>
              <p className="text-dim">{model.music.distinctArtists} different artists across {model.music.tracks} songs. You're an explorer, so ECHO leans adventurous with you.</p>
            </div>
          </Section>
        )}

        <Section title="Interest clusters" hint="Related themes you keep returning to, grouped by ECHO’s concept graph">
          {insights.clusters.length === 0 ? <p className="text-sm text-mist">Not enough signal yet.</p> : (
            <div className="flex flex-wrap gap-2">
              {insights.clusters.map((c) => (
                <div key={c.id} className="rounded-2xl border border-line bg-ink-3/60 px-3.5 py-2.5">
                  <p className="font-display">{c.label}</p>
                  <p className="text-xs text-dim">{c.concepts.map((x) => x.label).join(' · ')}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Cross-media threads" hint="The same quality showing up in different kinds of media">
          {insights.connections.length === 0 ? <p className="text-sm text-mist">Like things in two or more categories to reveal threads between them.</p> : (
            <ul className="space-y-2.5">
              {insights.connections.map((c) => (
                <li key={c.concept} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-display text-base">{c.label}</span>
                  <span className="text-dim">appears in</span>
                  {c.categories.map((x) => {
                    const m = CATEGORY_META[x.category];
                    return <span key={x.category} className="inline-flex items-center gap-1 rounded-full bg-ink-3 px-2 py-0.5 text-xs" style={{ color: m.color }}><m.icon className="h-3 w-3" />{m.label}</span>;
                  })}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Themes & moods" hint="Pin to always consider · Avoid to steer away · ✕ to forget">
          {insights.themes.length + insights.moods.length === 0 ? <p className="text-sm text-mist">Nothing learned yet.</p> : (
            <ul>
              {[...insights.themes, ...insights.moods, ...insights.qualities].sort((a, b) => b.weight - a.weight).slice(0, 18).map((t) => (
                <WeightRow key={t.id} id={t.id} weight={t.weight} max={maxTheme} onEdit={edit} pinned={model.explicit.pinnedConcepts.includes(t.id)} />
              ))}
            </ul>
          )}
          {adding ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {CONCEPTS.filter((c) => !(model.concepts[c.id] > 0.15)).map((c) => (
                <button key={c.id} type="button" onClick={() => { edit({ pinConcept: c.id }); setAdding(false); }} className="rounded-full border border-line px-2.5 py-1 text-xs text-mist hover:border-ember/50 hover:text-bone">{c.label}</button>
              ))}
            </div>
          ) : (
            <button type="button" onClick={() => setAdding(true)} className="mt-3 inline-flex items-center gap-1.5 text-sm text-ember"><Plus className="h-4 w-4" /> Add an interest</button>
          )}
        </Section>

        <Section title="Emerging & right now">
          <div className="space-y-3 text-sm">
            <div>
              <p className="flex items-center gap-1.5 text-xs text-dim"><TrendingUp className="h-3.5 w-3.5" /> Growing over the last weeks</p>
              <p className="mt-1">{insights.emerging.length ? insights.emerging.map((e) => e.label).join(', ') : <span className="text-mist">Emerging interests appear after a couple of weeks of activity.</span>}</p>
            </div>
            <div>
              <p className="text-xs text-dim">Current mood (short-term, fades within hours)</p>
              <p className="mt-1">{insights.currentMood.length ? insights.currentMood.map((e) => e.label).join(', ') : <span className="text-mist">No recent mood signals.</span>}</p>
            </div>
          </div>
        </Section>

        <Section title="Creators & genres">
          <div className="flex flex-wrap gap-1.5">
            {insights.creators.map((c) => (
              <span key={c.name} className="inline-flex items-center gap-1 rounded-full bg-ink-3 py-1 pr-1 pl-3 text-sm capitalize">{c.name}<button type="button" aria-label={`Forget ${c.name}`} onClick={() => edit({ removeCreator: c.name })} className="rounded-full p-0.5 text-dim hover:text-bone"><X className="h-3.5 w-3.5" /></button></span>
            ))}
            {insights.genres.map((g) => (
              <span key={g.name} className="inline-flex items-center gap-1 rounded-full border border-line py-1 pr-1 pl-3 text-sm capitalize text-mist">{g.name}<button type="button" aria-label={`Forget ${g.name}`} onClick={() => edit({ removeGenre: g.name })} className="rounded-full p-0.5 text-dim hover:text-bone"><X className="h-3.5 w-3.5" /></button></span>
            ))}
            {insights.creators.length + insights.genres.length === 0 && <p className="text-sm text-mist">Favourite creators and genres appear as you like things.</p>}
          </div>
        </Section>

        <Section title="What you’ve told me" hint="Statements from onboarding and conversations">
          <div className="space-y-2 text-sm">
            {model.explicit.likes.map((l) => <p key={l} className="flex items-center justify-between gap-2"><span>💛 You like <b>{l}</b></span><button type="button" aria-label={`Remove ${l}`} onClick={() => edit({ removeLike: l })} className="text-dim hover:text-bone"><X className="h-4 w-4" /></button></p>)}
            {model.explicit.dislikes.map((l) => <p key={l} className="flex items-center justify-between gap-2"><span>✕ You don’t like <b>{l}</b></span><button type="button" aria-label={`Remove ${l}`} onClick={() => edit({ removeDislike: l })} className="text-dim hover:text-bone"><X className="h-4 w-4" /></button></p>)}
            {model.explicit.statements.map((s) => <p key={s} className="flex items-start justify-between gap-2 italic text-mist"><span>“{s}”</span><button type="button" aria-label="Remove statement" onClick={() => edit({ removeStatement: s })} className="text-dim hover:text-bone"><X className="h-4 w-4" /></button></p>)}
            {insights.avoid.length > 0 && (
              <div className="pt-2">
                <p className="text-xs text-dim">Avoiding</p>
                <div className="mt-1 flex flex-wrap gap-1.5">{insights.avoid.map((a) => <button key={a.id} type="button" onClick={() => edit({ unblockConcept: a.id })} className="rounded-full border border-danger/30 px-2.5 py-0.5 text-xs text-danger" title="Stop avoiding">{a.label} ✕</button>)}</div>
              </div>
            )}
            {model.explicit.likes.length + model.explicit.dislikes.length + model.explicit.statements.length === 0 && <p className="text-mist">Try telling Echo AI “I love Tarkovsky” or “I can’t stand horror”.</p>}
          </div>
        </Section>
      </div>
      <div className="mt-8 px-4 md:px-8">
        <button
          type="button"
          onClick={async () => {
            if (!confirm('Reset your taste profile? Your library and history stay; learned preferences are erased.')) return;
            await api.resetProfile().catch((e) => toast(e.message, 'error'));
            qc.invalidateQueries({ queryKey: ['profile'] });
            toast('Taste profile reset.');
          }}
          className="inline-flex items-center gap-2 text-sm text-dim hover:text-danger"
        >
          <Trash2 className="h-4 w-4" /> Reset taste profile
        </button>
      </div>
    </div>
  );
}
