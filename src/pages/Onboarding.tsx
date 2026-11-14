import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeft, ArrowRight, Check, Search, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { CATEGORIES, type AnalyzedItem, type Category } from '@shared/types.ts';
import { CONCEPTS } from '@shared/engine/concepts.ts';
import { api } from '../lib/api';
import { CATEGORY_META, KIND_LABEL, year } from '../lib/meta';
import { EchoMark } from '../components/Echo';
import { ExplorationSlider } from '../components/Controls';
import { toast } from '../components/Toast';

const INTERESTS = CONCEPTS.filter((c) => c.group !== 'quality');

export default function Onboarding() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [cats, setCats] = useState<Category[]>([...CATEGORIES]);
  const [interests, setInterests] = useState<string[]>([]);
  const [favorites, setFavorites] = useState<AnalyzedItem[]>([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AnalyzedItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [description, setDescription] = useState('');
  const [exploration, setExploration] = useState(0.4);
  const [saving, setSaving] = useState(false);

  const steps = ['Welcome', 'Interests', 'Favorites', 'Your words'];

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await api.lookup(query.trim());
      setResults(r.items);
      if (!r.items.length) toast('No matches in the connected catalogs. Try another spelling.');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setSearching(false);
    }
  };

  const finish = async (skipAll = false) => {
    setSaving(true);
    try {
      await api.onboarding(
        skipAll
          ? { displayName: name || undefined }
          : { displayName: name || undefined, categories: cats, interests, description: description || undefined, exploration, favorites: favorites.map((f) => f.id) },
      );
      await qc.invalidateQueries({ queryKey: ['profile'] });
      nav('/', { replace: true });
    } catch (err) {
      toast((err as Error).message, 'error');
      setSaving(false);
    }
  };

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <div className="grain mx-auto flex min-h-dvh max-w-2xl flex-col px-5 pt-8 pb-28">
      <div className="flex items-center justify-between">
        <EchoMark size={36} />
        <button type="button" onClick={() => finish(true)} className="text-sm text-mist hover:text-bone">Skip for now</button>
      </div>
      <div className="mt-6 flex gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
        {steps.map((s, i) => (
          <div key={s} className={`h-1 flex-1 rounded-full transition ${i <= step ? 'bg-ember' : 'bg-ink-4'}`} />
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.section key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="mt-8 flex-1">
          {step === 0 && (
            <>
              <h1 className="font-display text-4xl leading-tight">Let’s tune ECHO to you.</h1>
              <p className="mt-3 text-mist">Four quick steps, all skippable. ECHO keeps learning from every like, save and skip, so this is just a starting point.</p>
              <label className="mt-8 block text-sm text-mist">
                What should I call you?
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Your name" className="mt-2 w-full rounded-2xl border border-line bg-ink-2 px-4 py-3.5 text-bone placeholder:text-dim focus:border-ember/60 focus:outline-none" />
              </label>
              <p className="mt-8 text-sm text-mist">What do you want to discover?</p>
              <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {CATEGORIES.map((c) => {
                  const m = CATEGORY_META[c];
                  const on = cats.includes(c);
                  return (
                    <button key={c} type="button" aria-pressed={on} onClick={() => setCats(toggle(cats, c))} className={`flex items-center gap-3 rounded-2xl border p-4 text-left transition ${on ? 'border-ember/60 bg-ember/10' : 'border-line bg-ink-2 hover:border-white/15'}`}>
                      <m.icon className="h-6 w-6" style={{ color: m.color }} />
                      <span className="font-medium">{m.label}</span>
                      {on && <Check className="ml-auto h-4 w-4 text-ember" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <h1 className="font-display text-4xl leading-tight">What pulls you in?</h1>
              <p className="mt-3 text-mist">Pick themes and moods you’re drawn to, across any medium.</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {INTERESTS.map((c) => {
                  const on = interests.includes(c.id);
                  return (
                    <button key={c.id} type="button" aria-pressed={on} onClick={() => setInterests(toggle(interests, c.id))} className={`rounded-full border px-3.5 py-2 text-sm transition ${on ? 'border-ember bg-ember font-semibold text-ink' : c.group === 'mood' ? 'border-line text-iris hover:border-iris/40' : 'border-line text-bone/85 hover:border-white/20'}`}>
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-4 text-xs text-dim"><span className="text-iris">Lilac</span> = moods · white = themes</p>
            </>
          )}

          {step === 2 && (
            <>
              <h1 className="font-display text-4xl leading-tight">A few things you love</h1>
              <p className="mt-3 text-mist">Films, books, artists, songs or shows. These are real catalog entries, and ECHO learns from their actual metadata.</p>
              <form onSubmit={search} className="mt-6 flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-dim" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Interstellar, Radiohead, Dune" className="w-full rounded-2xl border border-line bg-ink-2 py-3.5 pr-4 pl-10 placeholder:text-dim focus:border-ember/60 focus:outline-none" />
                </div>
                <button disabled={searching} className="rounded-2xl bg-bone px-4 font-semibold text-ink disabled:opacity-60">{searching ? '…' : 'Find'}</button>
              </form>
              {favorites.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {favorites.map((f) => (
                    <span key={f.id} className="inline-flex items-center gap-1.5 rounded-full border border-ember/40 bg-ember/10 py-1 pr-1.5 pl-3 text-sm">
                      {f.title}
                      <button type="button" aria-label={`Remove ${f.title}`} onClick={() => setFavorites(favorites.filter((x) => x.id !== f.id))} className="rounded-full p-0.5 hover:bg-ember/20"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  ))}
                </div>
              )}
              <ul className="mt-4 space-y-2">
                {results.map((r) => {
                  const on = favorites.some((f) => f.id === r.id);
                  const m = CATEGORY_META[r.category];
                  return (
                    <li key={r.id}>
                      <button type="button" onClick={() => setFavorites(on ? favorites.filter((f) => f.id !== r.id) : [...favorites, r].slice(0, 20))} className={`flex w-full items-center gap-3 rounded-2xl border p-2.5 text-left transition ${on ? 'border-ember/50 bg-ember/10' : 'border-line bg-ink-2 hover:border-white/15'}`}>
                        <div className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-ink-3">{r.artworkUrl && <img src={r.artworkUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}</div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.title}</p>
                          <p className="truncate text-xs text-mist"><span style={{ color: m.color }}>{KIND_LABEL[r.kind]}</span>{r.creators[0] ? ` · ${r.creators[0]}` : ''}{year(r.releaseDate) ? ` · ${year(r.releaseDate)}` : ''}</p>
                        </div>
                        {on && <Check className="h-5 w-5 text-ember" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {step === 3 && (
            <>
              <h1 className="font-display text-4xl leading-tight">In your own words</h1>
              <p className="mt-3 text-mist">Optional. Describe what you love and why. ECHO extracts the themes and moods.</p>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={4} placeholder="I love slow, atmospheric films about memory, music that feels like a long night drive, and books that make me rethink how I see the world…" className="mt-6 w-full resize-none rounded-2xl border border-line bg-ink-2 p-4 leading-relaxed placeholder:text-dim focus:border-ember/60 focus:outline-none" />
              <p className="mt-8 mb-3 text-sm text-mist">How far should ECHO reach?</p>
              <ExplorationSlider value={exploration} onChange={setExploration} />
            </>
          )}
        </motion.section>
      </AnimatePresence>

      <div className="safe-bottom fixed inset-x-0 bottom-0 border-t border-line bg-ink/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-5 py-3.5">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className="grid h-12 w-12 place-items-center rounded-full border border-line text-mist" aria-label="Back"><ArrowLeft className="h-5 w-5" /></button>
          )}
          {step < steps.length - 1 && <button type="button" onClick={() => setStep(step + 1)} className="text-sm text-mist hover:text-bone">Skip step</button>}
          <button
            type="button"
            disabled={saving}
            onClick={() => (step < steps.length - 1 ? setStep(step + 1) : finish())}
            className="ml-auto inline-flex items-center gap-2 rounded-full bg-ember px-6 py-3 font-semibold text-ink disabled:opacity-60"
          >
            {step < steps.length - 1 ? 'Continue' : saving ? 'Tuning…' : 'Start discovering'} <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
