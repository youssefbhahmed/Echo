# ECHO — Discover beyond the algorithm

ECHO is a personal discovery agent for **videos, music, films & series, books and podcasts**. It learns *why* you love what you love and uses that to find real content across all five media. Picks play inside the app through each platform's official embedded player.

- **One taste model across every medium.** A film you love shapes the books, music and podcasts you're offered.
- **Conversational discovery.** Ask for "the same existential feeling as Interstellar, but it doesn't have to be sci‑fi" or "music that starts melancholic and becomes uplifting".
- **Explainable and grounded.** Each pick says why it was chosen, using only real catalog metadata and your recorded preferences.
- **It actually learns.** Likes, saves, skips, ratings and dislikes change the profile weights that drive ranking. Tests verify this.
- **Zero mandatory cost.** It runs on free tiers (Supabase + Cloudflare Pages). AI inference is optional. A deterministic engine handles everything without it.
- **Installable PWA.** Works on Windows, macOS, Android, iPhone, iPad and any modern browser, synced through your account.

> Architecture and design decisions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Contents
1. [Feature status](#feature-status)
2. [Quick start (local)](#quick-start-local)
3. [Deploy for free (Supabase + Cloudflare)](#deploy-for-free)
4. [Content provider setup](#content-provider-setup)
5. [Optional AI](#optional-ai)
6. [Environment variables](#environment-variables)
7. [Testing](#testing)
8. [Free-tier limits and possible costs](#free-tier-limits-and-possible-costs)
9. [Security model](#security-model)
10. [Troubleshooting](#troubleshooting)
11. [Known limitations](#known-limitations)
12. [Project layout](#project-layout)

---

## Feature status

Legend: ✅ implemented **and tested** · 🟢 implemented, verified manually or partially tested · 🟡 implemented, not verifiable here (needs your credentials) · ⏳ planned

| Area | Feature | Status |
|---|---|---|
| Accounts | Email + password sign‑up/sign‑in (Supabase Auth) | ✅ e2e |
| | Magic‑link sign‑in | 🟡 needs SMTP on hosted project (Supabase's built-in mailer is rate-limited) |
| | Cross‑device sync (library, taste, chats) | ✅ e2e (second browser context, same account) |
| | Data export (JSON) and account deletion | ✅ API tests |
| Onboarding | Categories, interests, real favorites lookup, free‑text taste, exploration level; every step skippable | ✅ e2e |
| Discover | Personalised multi‑category feed, mood chips, category tabs, refresh, recently discovered | ✅ e2e |
| | Exploration slider (Familiar ↔ Adventurous) that changes ranking *and* retrieval | ✅ unit tests (ranking flips) + e2e |
| | Like / save / dislike / skip / rate / finished / collections | ✅ e2e + API tests |
| Echo AI | Natural‑language requests → intent, mood, themes, references, negations, trajectory, duration, language | ✅ unit tests (all five example prompts from the brief) |
| | Conversational refinement ("only books", "less dark", "more like the second one") | ✅ unit + API + e2e |
| | Memory of explicit statements ("I love Tarkovsky") into the long-term profile; moods kept short-term | ✅ API tests |
| | Clarifying questions for vague requests | ✅ unit tests |
| Engine | Hybrid ranking: query relevance, deep (concept) and surface (genre/creator) affinity, novelty, context, quality | ✅ unit tests |
| | Cross‑media transfer through a shared concept space | ✅ unit tests (book + film likes lift an unrated podcast) |
| | MMR diversity, per‑creator caps, emotional‑trajectory sequencing | ✅ unit tests |
| | Grounded explanations (no invented reasons; inherited search evidence never claimed) | ✅ unit tests |
| | Feedback learning with decay (long-term ~120‑day half-life, mood ~8 h) | ✅ unit tests |
| | Collaborative filtering (item‑item, aggregate‑only, switches on at ≥ 20 active users) | 🟢 SQL function tested to stay *off* below threshold; activation untested (needs real users) |
| | Semantic embeddings (Supabase built‑in `gte-small`, pgvector) | 🟡 opt‑in (`ECHO_EMBEDDINGS=on`); runs only in Supabase's Edge Runtime |
| | Optional LLM intent enrichment (any OpenAI‑compatible free tier) | 🟡 code + validation tested with mocks; live provider untested |
| | Optional local Ollama (per device, browser → `localhost:11434`) | 🟡 needs Ollama on your machine |
| Playback | YouTube IFrame Player API (privacy‑enhanced host), respects embedding restrictions | 🟡 needs `YOUTUBE_API_KEY` (normalisation unit‑tested) |
| | Spotify official embeds (tracks, albums, playlists, shows, episodes) | 🟡 needs Spotify app credentials |
| | Music and podcasts come from Spotify only (no other audio source) | ✅ unit tests (Spotify reported as "unconfigured" until keys are set) |
| | TMDB official trailers via YouTube embed | 🟡 needs TMDB key |
| Integrations | Open Library, TVmaze (keyless) | ✅ live API integration tests |
| | TMDB, YouTube Data API, Spotify Web API | 🟡 adapters implemented to current docs; need your keys |
| | Spotify OAuth (PKCE) + playlist creation from collections | 🟡 needs Spotify app + allow-listed users |
| My Taste | Constellation visualisation, clusters, cross‑media threads, emerging interests, current mood | ✅ e2e (renders) + unit tests (insights) |
| | Pin / avoid / forget concepts, remove creators/genres/statements, reset | ✅ API tests (edit) |
| Library | Saved / loved / finished tabs, search, category filter, collections, export collection to Spotify | ✅ e2e (library); Spotify export 🟡 |
| PWA | Manifest, icons, service worker, offline app shell, install prompt / iOS guidance | ✅ verified on production build |
| Security | RLS on every user table, server-only token/cache tables, JWT verification, rate limiting, input validation, CORS allowlist, CSP | ✅ 20 pgTAP tests + API tests + CSP check |
| Ops | Daily cleanup job (cache expiry, YouTube 30‑day policy) via pg_cron | 🟢 SQL implemented; cron runs on hosted Supabase |
| Future | Restaurants / destinations / events providers, A/B experimentation, multi‑language UI, offline evaluation dashboard | ⏳ planned (architecture ready: see docs) |

---

## Live deployment

- App: https://echo-discover.youssef-bhahmed.workers.dev
- API health: https://mlmrzuhhwqvkfjywcjwf.supabase.co/functions/v1/health

## Quick start (local)

**Prerequisites:** Node 20+ and Docker (for the local Supabase stack). Deno is installed as a dev dependency.

```bash
npm install
```

```bash
npx supabase start
```

```bash
cp supabase/functions/.env.example supabase/functions/.env
```

```bash
bash scripts/local-env.sh
```

`scripts/local-env.sh` writes `supabase/functions/.env.local` with your local stack's URL and keys. Next, create `.env.local` for the frontend from the values printed by `npx supabase status`:

```bash
cat > .env.local <<'EOF'
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY or PUBLISHABLE_KEY from `npx supabase status`>
VITE_FUNCTIONS_URL=http://127.0.0.1:54331/functions/v1
EOF
```

Run the Edge Functions (choose one):

```bash
npm run functions:dev
```

(`functions:dev` runs every function in one host Deno process on port 54331. Alternatively, run `npm run sb:functions` to use Supabase's Docker Edge Runtime on port 54321; then drop `VITE_FUNCTIONS_URL`.)

```bash
npm run dev
```

Open http://localhost:5173, create an account and go through onboarding. With **no provider keys at all**, books (Open Library) and TV series (TVmaze) already work. Music and podcasts need Spotify keys; videos need a YouTube key; films need TMDB.

---

## Deploy for free

The whole stack runs in the cloud. Your computer does not need to stay on.

### 1. Supabase (database, auth, Edge Functions)

1. Create a project at https://supabase.com (Free plan). Note the **project ref** (the `xxxx` in `https://xxxx.supabase.co`).
2. Create a **personal access token**: Dashboard → Account → Access Tokens.
3. Find the **database password** you set when creating the project (Project Settings → Database to reset it).
4. Put provider keys you have into `supabase/functions/.env` (copy from `.env.example`). Set `ALLOWED_ORIGINS` to your production URL(s), for example `https://echo.pages.dev`.
5. Deploy migrations, secrets and functions:

```bash
SUPABASE_PROJECT_REF=xxxx SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_DB_PASSWORD=... npm run sb:deploy
```

6. Check https://xxxx.supabase.co/functions/v1/health. It lists which providers are configured.
7. **Auth redirect URLs:** Dashboard → Authentication → URL Configuration
   - Site URL: `https://<your-pages-domain>`
   - Additional redirect URLs: `https://<your-pages-domain>/**`, `http://localhost:5173/**`
8. *(Optional)* Authentication → Providers → Email: keep "Confirm email" on, and configure custom SMTP for reliable delivery.

> **New API keys:** if your project uses `sb_publishable_…` / `sb_secret_…` keys and you have **disabled the legacy JWT keys**, add `ECHO_SERVICE_KEY=<your sb_secret_ key>` to the function secrets. Otherwise the auto‑injected service key is used.

### 2. Cloudflare (frontend, Workers static assets)

Cloudflare now routes new static sites through Workers static assets; `wrangler.toml` is set up for it (SPA fallback via `not_found_handling`, security headers from `public/_headers`).

1. Create an API token: Cloudflare → My Profile → API Tokens → **Edit Cloudflare Workers** template. Note your **Account ID** (Workers & Pages overview).
2. Build with your public Supabase values and deploy:

```bash
VITE_SUPABASE_URL=https://xxxx.supabase.co VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_... npm run build
```

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy
```

3. The site is served at `https://echo-discover.<your-subdomain>.workers.dev`. Add that URL to Supabase **Auth redirect URLs** and to **`ALLOWED_ORIGINS`**.

---

## Content provider setup

All provider secrets live **only** in Supabase function secrets and never reach the browser.

| Provider | Used for | Key needed | How to get it |
|---|---|---|---|
| **Open Library** | Books | No | — |
| **TVmaze** | TV series fallback (when TMDB isn't set) | No | — |
| **TMDB** | Films & series, keywords, similar titles, trailers | Yes (free, non‑commercial) | themoviedb.org → Settings → API → copy the **API Read Access Token** into `TMDB_READ_TOKEN` |
| **YouTube Data API v3** | Videos, documentaries, interviews | Yes (free quota) | Google Cloud Console → new project → enable *YouTube Data API v3* → Credentials → API key → restrict to that API → `YOUTUBE_API_KEY` |
| **Spotify Web API** | Songs, albums, playlists, podcasts (the only music/podcast source); playlist creation | Yes | developer.spotify.com → Dashboard → Create app (Web API) → `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`. Redirect URI: `https://xxxx.supabase.co/functions/v1/spotify`. In Development Mode, add each user's Spotify email under *User Management* (max 5). |

Set them with:

```bash
npx supabase secrets set TMDB_READ_TOKEN=... YOUTUBE_API_KEY=... SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=...
```

**Spotify 2026 Development Mode constraints** (from Spotify's February 2026 migration guide): the app owner needs **Spotify Premium**; **5 users** per app; `/search` returns at most **10** items per type; several endpoints (artist top tracks, browse, batch lookups) are gone for new dev-mode apps. ECHO uses only endpoints that remain (search, `POST /me/playlists`, `POST /playlists/{id}/items`) and embeds for playback. Spotify's Developer Policy forbids feeding Spotify content into ML/AI models, so ECHO never sends Spotify items to embeddings or LLMs (enforced in `pipeline.ts`).

**YouTube policy:** API data is cached for at most 2 days for searches. A daily job strips YouTube metadata older than ~30 days, and the Library re-fetches it on display (1 quota unit per 50 videos).

---

## Music: AI curator + Spotify import

- **Import your Spotify Liked Songs:** Settings → *Import from Spotify* (export Liked Songs as CSV at exportify.app). Songs go to your library as loved; ECHO learns your styles, artists, eras and moods from genres and audio features (song titles are deliberately ignored), and builds a **Music DNA** shown in My Taste. Re-importing replaces the previous import instead of stacking.
- **Taste lanes:** the import groups your songs into lanes (e.g. Hip-hop & R&B, Rock & metal, Afro & melodic house). Untagged songs join the lane of their nearest tagged neighbours by audio features; recent saves weigh more (12-month half-life). Regional lanes (French, Arabic, Maghreb) share at most 12% and only take 2015+ releases. Lanes are visible in My Taste and as shelves in Discover.
- **AI music curator:** Spotify's Development Mode can no longer discover music by mood or genre, so when an AI provider is configured, each refresh briefs it with 3 of your lanes (generic style, mood, era and familiarity words only, never song or artist names). It proposes real recordings, and every pick is resolved and checked before it is shown: ListenBrainz's keyless metadata→Spotify mapping first, then `GET /v1/tracks/{id}` (artist/title match, playable, era, not already in your library, no live/remix versions), then a few Spotify searches when search isn't rate-limited. Songs stay grouped by lane in the curator's listening order, one per artist. Skips and dislikes lower the artist and the lane.
- **Full songs (Spotify Premium):** after *Connect Spotify* (Settings), ECHO plays whole songs in your Spotify app via Spotify Connect (`user-modify-playback-state`, `user-read-playback-state`, `user-read-currently-playing`) and shows its own now-playing bar. If Spotify isn't open on any device, ECHO offers to open the app and starts the queue when you come back. Without a connection (or without Premium) songs play as 30-second previews in Spotify's embed. Accounts connected before these permissions existed need one *Reconnect Spotify*.

### Steering ECHO durably

- **My Taste → Music mix:** every style family with its live share; **Less / More / Never** (Never blocks a family from the curator and from ranking until you allow it again).
- **❤️ toggles:** tapping a loved item again un-likes it and reverses most of what the like taught.
- **"No X" in Echo AI** is remembered as a long-term dislike (removable in My Taste).
- **Platforms are source filters:** "youtube podcasts" = podcasts from YouTube only; "spotify podcasts" = Spotify only; bare "youtube" = videos, bare "spotify" = music.
- **Reactions are never lost:** if one can't be sent (offline, expired session), it is kept on the device and retried automatically.

### How ECHO understands requests

With an AI provider configured, every message is interpreted **AI-first** (`engine/understand.ts`): any language, conversation-aware (follow-ups like "only the YouTube ones", "plutôt en français" resolve against the previous request), producing media types, source filters, a precise search phrase per category, themes/moods, exclusions and remembered preferences. The rules parser still runs: it is the fallback when AI is unavailable or rate-limited, and its explicit readings (negations, "doesn't have to be", literal titles) are guardrails the AI cannot override; titles and preferences the user didn't actually write are discarded.

Evaluation (`tests/eval/understanding.ts`, 30 real requests incl. French and follow-ups): **rules alone 19/30, AI-first 29/30** (Groq `qwen/qwen3.8-27b`). Use `AI_MUSIC_MODEL` to run the music curator on a different model (e.g. `openai/gpt-oss-120b`), since free-tier rate limits are per model.

## Optional AI

ECHO is fully functional without AI. The rules engine (`engine/intent.ts`) parses requests, and the hybrid ranker does the rest.

- **Server LLM (optional):** any OpenAI-compatible endpoint. Only the user's request text is sent, never catalog data. Output is validated against ECHO's vocabulary, and the model cannot invent titles: references must literally appear in the user's text.

```bash
npx supabase secrets set AI_BASE_URL=https://api.groq.com/openai/v1 AI_MODEL=llama-3.1-8b-instant AI_API_KEY=gsk_...
```

  Other free-tier options: OpenRouter `:free` models, Google Gemini's OpenAI-compatible endpoint. Check each provider's current free quota.
- **Embeddings (optional):** `ECHO_EMBEDDINGS=on` uses Supabase's built-in `gte-small` model inside Edge Functions (no external API, no cost beyond function CPU time). Vectors are stored in pgvector and blended into ranking.
- **Local Ollama (optional, per device):** Settings → AI providers → *Local Ollama*. Start Ollama with your site allowed:

```bash
OLLAMA_ORIGINS=https://<your-pages-domain> ollama serve
```

---

## Environment variables

| Where | Variable | Required | Notes |
|---|---|---|---|
| Frontend (`.env.local` / Cloudflare) | `VITE_SUPABASE_URL` | yes | public |
| | `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | public (RLS-enforced) |
| | `VITE_FUNCTIONS_URL` | no | override functions base URL (local router) |
| Functions (`supabase/functions/.env` → `supabase secrets set`) | `ALLOWED_ORIGINS` | recommended | CORS + OAuth redirect allowlist |
| | `TMDB_READ_TOKEN` / `TMDB_API_KEY` | no | films & series |
| | `YOUTUBE_API_KEY` | no | videos |
| | `YOUTUBE_REGION` | no | ISO country code; skips videos geo-blocked there |
| | `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_MARKET`, `SPOTIFY_REDIRECT_URI` | no | music, podcasts, OAuth |
| | `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | no | optional LLM |
| | `ECHO_EMBEDDINGS` | no | `on` to enable gte-small |
| | `ECHO_CF_MIN_USERS` | no | collaborative filtering threshold (default 20) |
| | `ECHO_SERVICE_KEY` | only with legacy keys disabled | your `sb_secret_…` key |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically into hosted functions.

---

## Testing

| Suite | Command | What it covers | Needs |
|---|---|---|---|
| Unit (Vitest) | `npm test` | intent parsing (all brief examples), learning, exploration, diversity, trajectory, grounding, provider normalisation (recorded real payloads), pipeline with mocked network | nothing |
| Type checks | `npm run typecheck` and `npm run typecheck:functions` | frontend + Deno Edge Functions | nothing |
| Database (pgTAP) | `npm run test:db` | RLS isolation, server-only tables, signup trigger, CF threshold | local Supabase |
| API integration (Deno) | `npm run test:api` | auth rejection, validation, onboarding, feed, feedback learning, chat memory + refinement, cross-user isolation, export, deletion, against real Postgres + real keyless providers | local Supabase + `npm run functions:dev` |
| End-to-end (Playwright) | `npm run test:e2e` | full journey on mobile (Pixel 7) and desktop, cross-device sync, PWA assets, route protection | above + `npm run dev` |
| Live pipeline smoke | `npx deno run -A scripts/smoke-pipeline.ts "your request"` | the real pipeline against live provider APIs | network |

Last local run: 36 unit tests, 20 pgTAP, 11 API steps and 8 Playwright tests, all passing.

> If Playwright can't find a browser because your system has a different version installed, set `PW_CHROMIUM=/path/to/chrome`.

---

## Free-tier limits and possible costs

Verify against each provider's current pricing page; these change.

| Service | Free allowance (as documented late 2026) | What happens at the limit | Paid path |
|---|---|---|---|
| Supabase Free | 500 MB database, 50k monthly active users, 5 GB egress, 500k Edge Function invocations/month, 2 active projects | **Projects pause after 1 week of inactivity** (data kept; restore from the dashboard). Over quota: restricted until next cycle | Pro $25/month (no pausing, 8 GB DB) |
| Cloudflare Pages Free | 500 builds/month; static bandwidth unmetered | builds queue/fail | Pages Pro |
| YouTube Data API | 10,000 units/day; a search costs 100 units (~100 uncached searches/day). ECHO caches searches 48 h and caps YouTube searches per request | ECHO marks YouTube "quota" for 6 h and serves other sources | Request a quota increase (free, audited) |
| Spotify Web API | Free; Development Mode needs Premium owner, 5 users | 429 rate limiting | Extended Quota Mode (application required) |
| TMDB | Free for non‑commercial use with attribution (shown in Settings → About) | n/a | Commercial licence from TMDB |
| Open Library | Free, no key; please be polite (ECHO caches 7 days, sends a User-Agent) | throttling | — |
| TVmaze | Free, CC BY‑SA; rate limited per IP; cached 3 days | 429 | Premium API |
| LLM providers | Optional; free tiers vary and change often | ECHO falls back to rules | provider pricing |

**Costs to watch if usage grows:** Supabase Pro (pausing, DB size), YouTube quota, an LLM if you enable one. Nothing in ECHO requires a paid plan.

---

## Security model

- **Row-level security** on every user table (`profiles`, `taste_profiles`, `interactions`, `library_items`, `collections`, `collection_items`, `chat_*`, `recommendation_events`, `taste_snapshots`). Policies use `auth.uid()`. Covered by `supabase/tests/rls.test.sql`.
- **Server-only tables** (`oauth_tokens`, `oauth_states`, `provider_cache`, `provider_status`, `rate_limits`): RLS on, no policies, privileges revoked from `anon`/`authenticated`.
- **Shared catalog** (`content_items`) is read-only for signed-in users and written only by Edge Functions.
- **Secrets** (provider keys, service key, Spotify tokens) exist only in Supabase function secrets / server tables. The browser holds only the publishable key.
- **Edge Functions** verify the caller's JWT (`auth.getUser`), run user queries with the caller's JWT so RLS applies, validate bodies with Zod, enforce per-user rate limits (Postgres fixed window), and return no stack traces.
- **Spotify OAuth** uses Authorization Code + PKCE with server-stored state (15‑minute expiry) and a redirect allowlist.
- **CORS** allowlist via `ALLOWED_ORIGINS`; **CSP** and security headers via `public/_headers`.
- **Untrusted AI output** (server LLM or client Ollama) is sanitised to known ids. Referenced titles must appear in the user's own text.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "ECHO isn't configured yet" | `.env.local` (or Cloudflare env vars) missing `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`; rebuild after changing them. |
| "ECHO can't reach its server" / CORS errors | Functions not deployed, or your site's origin isn't in `ALLOWED_ORIGINS`. Check `/functions/v1/health`. |
| 401 "session expired" from functions | Sign out/in. If you disabled legacy JWT keys, set `ECHO_SERVICE_KEY`. |
| No videos | `YOUTUBE_API_KEY` missing or daily quota used (Discover shows a notice). |
| No music or podcasts | Spotify isn't configured; set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`. |
| Spotify "refused … allowlist" | Add the user's Spotify account in the Spotify dashboard (Development Mode). |
| Magic link/confirmation email never arrives | Supabase's default mailer is heavily rate-limited; configure SMTP or use password sign-in. |
| Project stopped responding after a quiet week | Supabase Free pauses inactive projects; restore it from the dashboard. |
| Local `supabase functions serve` fails with TLS/npm errors behind a corporate proxy | Use `npm run functions:dev` (host Deno), with `DENO_CERT` pointing at your CA bundle. |
| `supabase db push` asks for a password | Pass `SUPABASE_DB_PASSWORD` (Project Settings → Database). |

---

## Known limitations

- **Music and podcasts require Spotify.** By design there is no fallback source; without Spotify keys these two categories are empty and Discover says so.
- **Concept analysis is lexicon-based.** It is transparent and deterministic but literal: it can miss nuance or be fooled by titles. Embeddings and the optional LLM help; neither is required.
- **YouTube, TMDB and Spotify adapters are written to current documentation** and unit-tested on representative payloads, but couldn't be exercised live here without keys. Verify with `scripts/smoke-pipeline.ts` after adding keys.
- **Collaborative filtering** stays dormant until there are ≥ 20 active users. Personal use relies on content-based and semantic signals.
- **Feedback isn't "un-learned"** when you undo a like; the next interactions and decay correct it. You can always edit the profile directly in My Taste.
- **Ollama from a hosted HTTPS site** works only where the browser allows `http://localhost` from secure pages (Chromium does; some Safari versions don't).
- **Supabase Free pausing** after a week of inactivity means a dormant personal deployment must be restored from the dashboard.

---

## Project layout

```
src/                         React PWA (Vite, TypeScript, Tailwind v4, Motion)
  pages/                     Discover, Chat (Echo AI), Taste, Library, Settings, Onboarding, Auth
  components/                MediaCard, Player (official embeds), Controls, Shell, …
  lib/                       Supabase client, API client, auth, local Ollama
supabase/
  migrations/                schema, RLS, functions, cron
  tests/                     pgTAP RLS tests
  functions/
    _shared/engine/          recommendation engine (pure TS; shared by server + client types)
    _shared/providers/       YouTube, Spotify, TMDB, TVmaze, Open Library adapters
    discover|chat|feedback|profile|catalog|account|spotify|health/   Edge Functions
scripts/                     dev router, deploy, smoke test, icons, local env
tests/                       unit (Vitest), integration (Deno), e2e (Playwright)
docs/ARCHITECTURE.md         system design and decisions
```
