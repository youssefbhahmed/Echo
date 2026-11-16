import { NavLink, Outlet } from 'react-router-dom';
import { Compass, Library, MessageCircle, Settings, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { EchoMark, Wordmark } from './Echo';
import { MiniPlayer } from './MiniPlayer';
import { usePlayer } from '../lib/player';

const NAV = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/echo', label: 'Echo AI', icon: MessageCircle },
  { to: '/taste', label: 'My Taste', icon: Sparkles },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Shell() {
  const { current } = usePlayer();
  return (
    <div className="grain min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-bone focus:px-3 focus:py-2 focus:text-ink">Skip to content</a>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-ink/40 px-5 py-8 backdrop-blur-xl md:flex">
        <Wordmark />
        <p className="mt-1.5 pl-[38px] font-display text-[13px] text-dim italic">Discover beyond the algorithm</p>
        <nav className="mt-10 space-y-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `relative flex h-11 items-center gap-3 rounded-xl px-3 text-[15px] transition-colors duration-150 ${isActive ? 'bg-white/[0.06] text-bone' : 'text-mist hover:bg-white/[0.03] hover:text-bone'}`}>
              {({ isActive }) => (
                <>
                  {isActive && <motion.span layoutId="rail-active" className="absolute top-2.5 bottom-2.5 left-0 w-[3px] rounded-full bg-ember" transition={{ type: 'spring', stiffness: 500, damping: 40 }} aria-hidden />}
                  <Icon className={`h-5 w-5 ${isActive ? 'text-ember' : ''}`} aria-hidden />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl border border-line bg-ink-2/60 p-4">
          <EchoMark size={22} />
          <p className="mt-2 text-xs leading-relaxed text-mist">Every like, save and skip teaches ECHO a little more about you.</p>
        </div>
      </aside>
      <main id="main" className={`min-w-0 flex-1 ${current ? 'pb-56 md:pb-36' : 'pb-32 md:pb-16'}`}>
        <div className="mx-auto max-w-[1280px]">
          <Outlet />
        </div>
      </main>
      <MiniPlayer />
      {/* Mobile tab bar */}
      <nav className="pb-safe-nav fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/80 backdrop-blur-2xl md:hidden" aria-label="Main">
        <div className="mx-auto grid max-w-lg grid-cols-5 px-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `relative flex flex-col items-center gap-1 pt-2.5 pb-1.5 text-[10.5px] font-medium transition-colors ${isActive ? 'text-bone' : 'text-dim'}`}>
              {({ isActive }) => (
                <>
                  {isActive && <motion.span layoutId="tab-active" className="absolute top-0 h-[2px] w-8 rounded-full bg-ember" transition={{ type: 'spring', stiffness: 500, damping: 40 }} aria-hidden />}
                  <Icon className={`h-[22px] w-[22px] ${isActive ? 'text-ember' : ''}`} aria-hidden />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function PageHeader({ eyebrow, title, children }: { eyebrow?: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="pt-safe px-4 md:px-8 md:pt-12">
      <div className="mb-6 md:hidden"><Wordmark /></div>
      {eyebrow && <p className="text-xs font-semibold tracking-[0.2em] text-ember uppercase">{eyebrow}</p>}
      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-[34px] leading-[1.06] font-medium tracking-[-0.01em] text-balance md:text-[52px]">{title}</h1>
        {children}
      </div>
    </header>
  );
}
