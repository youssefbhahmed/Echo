import { NavLink, Outlet } from 'react-router-dom';
import { Compass, Library, MessageCircle, Settings, Sparkles } from 'lucide-react';
import { Wordmark } from './Echo';

const NAV = [
  { to: '/', label: 'Discover', icon: Compass, end: true },
  { to: '/echo', label: 'Echo AI', icon: MessageCircle },
  { to: '/taste', label: 'My Taste', icon: Sparkles },
  { to: '/library', label: 'Library', icon: Library },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Shell() {
  return (
    <div className="grain min-h-dvh md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-bone focus:px-3 focus:py-2 focus:text-ink">Skip to content</a>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line px-4 py-6 md:flex">
        <Wordmark />
        <p className="mt-1 pl-[38px] font-display text-xs text-dim italic">Discover beyond the algorithm</p>
        <nav className="mt-10 space-y-1" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 text-[15px] transition ${isActive ? 'bg-ink-3 text-bone' : 'text-mist hover:bg-ink-2 hover:text-bone'}`}>
              {({ isActive }) => (
                <>
                  <Icon className={`h-5 w-5 ${isActive ? 'text-ember' : ''}`} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main id="main" className="min-w-0 flex-1 pb-28 md:pb-10">
        <Outlet />
      </main>
      {/* Mobile tab bar */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line bg-ink/85 backdrop-blur-xl md:hidden" aria-label="Main">
        <div className="mx-auto grid max-w-lg grid-cols-5">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `flex flex-col items-center gap-1 py-2.5 text-[10.5px] font-medium ${isActive ? 'text-bone' : 'text-dim'}`}>
              {({ isActive }) => (
                <>
                  <Icon className={`h-[22px] w-[22px] ${isActive ? 'text-ember' : ''}`} />
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
    <header className="safe-top px-4 pt-6 md:px-8 md:pt-10">
      <div className="mb-4 md:hidden"><Wordmark /></div>
      {eyebrow && <p className="text-xs font-semibold tracking-[0.2em] text-ember uppercase">{eyebrow}</p>}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-[34px] leading-[1.05] font-medium md:text-5xl">{title}</h1>
        {children}
      </div>
    </header>
  );
}
