import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/** A horizontal row with snap scrolling, edge fades, and arrow buttons on desktop. */
export function Shelf({ title, subtitle, children, id, action }: { title: string; subtitle?: string; children: React.ReactNode; id: string; action?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const scroll = (dir: 1 | -1) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: 'smooth' });
  return (
    <section className="mt-11" aria-labelledby={id}>
      <div className="flex items-end justify-between gap-4 px-4 md:px-8">
        <div>
          <h2 id={id} className="font-display text-[22px] leading-tight md:text-[26px]">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-mist">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-1.5">
          {action}
        <div className="hidden gap-1.5 md:flex">
          <button type="button" onClick={() => scroll(-1)} aria-label={`Scroll ${title} left`} className="grid h-9 w-9 place-items-center rounded-full border border-line text-mist transition-colors hover:border-white/20 hover:text-bone"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={() => scroll(1)} aria-label={`Scroll ${title} right`} className="grid h-9 w-9 place-items-center rounded-full border border-line text-mist transition-colors hover:border-white/20 hover:text-bone"><ChevronRight className="h-4 w-4" /></button>
        </div>
        </div>
      </div>
      <div ref={ref} className="scrollbar-none scroll-fade-x mt-4 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 md:scroll-px-8 md:gap-5 md:px-8">
        {children}
      </div>
    </section>
  );
}
