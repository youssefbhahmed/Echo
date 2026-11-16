import { CATEGORIES, type Category } from '@shared/types.ts';
import { conceptLabel, MOOD_CHIPS } from '@shared/engine/concepts.ts';
import { CATEGORY_META } from '../lib/meta';

export function ExplorationSlider({ value, onChange, compact }: { value: number; onChange: (v: number) => void; compact?: boolean }) {
  const label = value < 0.34 ? 'Familiar' : value < 0.67 ? 'Balanced' : 'Adventurous';
  const hint = value < 0.34 ? 'Strongly aligned with what you already love' : value < 0.67 ? 'A mix of the familiar and the unexpected' : 'Unfamiliar territory, connected to your deeper interests';
  // Rings widen as exploration grows — a visual echo of reaching further out.
  const rings = [0, 1, 2];
  return (
    <div className={compact ? '' : 'rounded-[var(--radius-card)] border border-line bg-ink-2/70 p-4'}>
      <div className="flex items-center gap-4">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="shrink-0">
          <circle cx="22" cy="22" r="3.5" fill="var(--color-ember)" />
          {rings.map((i) => (
            <circle key={i} cx="22" cy="22" r={7 + i * (3 + value * 4.5)} fill="none" stroke="var(--color-ember)" strokeOpacity={0.55 - i * 0.15} strokeWidth="1.5" style={{ transition: 'r .4s var(--ease-echo)' }} />
          ))}
        </svg>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between">
            <label htmlFor="exploration" className="font-display text-lg">{label}</label>
            <span className="text-xs text-dim">{Math.round(value * 100)}%</span>
          </div>
          {!compact && <p className="text-xs text-mist">{hint}</p>}
        </div>
      </div>
      <input id="exploration" type="range" min={0} max={1} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} className="echo-range mt-4" aria-valuetext={label} />
      <div className="mt-1.5 flex justify-between text-[11px] tracking-wide text-dim uppercase">
        <span>Familiar</span>
        <span>Balanced</span>
        <span>Adventurous</span>
      </div>
    </div>
  );
}

export function MoodChips({ selected, onToggle }: { selected: string[]; onToggle: (m: string) => void }) {
  return (
    <div className="scrollbar-none scroll-fade-x -mx-4 flex gap-2 overflow-x-auto px-4 py-0.5" role="group" aria-label="Moods">
      {MOOD_CHIPS.map((m) => {
        const on = selected.includes(m);
        return (
          <button key={m} type="button" aria-pressed={on} onClick={() => onToggle(m)} className={`h-9 shrink-0 rounded-full border px-3.5 text-[13.5px] transition-colors duration-150 ${on ? 'border-ember bg-ember font-semibold text-ink' : 'border-line text-mist hover:border-white/20 hover:text-bone'}`}>
            {conceptLabel(m).replace(' & ', ' · ')}
          </button>
        );
      })}
    </div>
  );
}

export function CategoryTabs({ value, onChange }: { value: Category | 'all'; onChange: (c: Category | 'all') => void }) {
  const tabs: Array<Category | 'all'> = ['all', ...CATEGORIES];
  return (
    <div className="scrollbar-none scroll-fade-x -mx-4 flex gap-1.5 overflow-x-auto px-4 py-0.5" role="tablist" aria-label="Categories">
      {tabs.map((t) => {
        const on = value === t;
        const meta = t === 'all' ? null : CATEGORY_META[t];
        const Icon = meta?.icon;
        return (
          <button key={t} role="tab" aria-selected={on} type="button" onClick={() => onChange(t)} className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm transition-colors duration-150 ${on ? 'bg-bone font-semibold text-ink' : 'bg-white/[0.05] text-mist hover:bg-white/[0.08] hover:text-bone'}`}>
            {Icon && <Icon className="h-4 w-4" aria-hidden style={{ color: on ? undefined : meta!.color }} />}
            {t === 'all' ? 'Everything' : meta!.label}
          </button>
        );
      })}
    </div>
  );
}
