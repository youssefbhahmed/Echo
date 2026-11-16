import { Play } from 'lucide-react';

/** "Play all" for a shelf or lane: plays its songs in order. `label` names the lane for screen readers. */
export function PlayAll({ onClick, label }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label ? `Play all: ${label}` : undefined}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-bone px-4 text-[13px] font-semibold text-ink transition-transform active:scale-95"
    >
      <Play className="h-3.5 w-3.5 fill-current" aria-hidden /> Play all
    </button>
  );
}
