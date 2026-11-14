// Optional, device-local AI: parse requests with a local Ollama model, then send only the
// structured hint to ECHO's server (which validates it). Ollama is never required.
import { INTENT_SYSTEM_PROMPT } from '@shared/engine/ai.ts';

export interface LocalAiSettings {
  enabled: boolean;
  url: string;
  model: string;
}

const KEY = 'echo.localAi';

export function getLocalAi(): LocalAiSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { enabled: false, url: 'http://localhost:11434', model: 'llama3.2', ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { enabled: false, url: 'http://localhost:11434', model: 'llama3.2' };
}

export function setLocalAi(s: LocalAiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export async function localIntentHint(text: string): Promise<Record<string, unknown> | undefined> {
  const s = getLocalAi();
  if (!s.enabled) return undefined;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${s.url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.model, stream: false, format: 'json', messages: [{ role: 'system', content: INTENT_SYSTEM_PROMPT }, { role: 'user', content: text }] }),
    });
    clearTimeout(t);
    if (!res.ok) return undefined;
    const data = await res.json();
    return JSON.parse(data.message?.content ?? '{}');
  } catch {
    return undefined; // silently fall back to server-side parsing
  }
}

export async function testLocalAi(s: LocalAiSettings): Promise<string> {
  const res = await fetch(`${s.url.replace(/\/$/, '')}/api/tags`).catch(() => null);
  if (!res?.ok) return 'Could not reach Ollama. Is it running, with OLLAMA_ORIGINS allowing this site?';
  const data = await res.json();
  const has = (data.models ?? []).some((m: { name: string }) => m.name.startsWith(s.model));
  return has ? `Connected. Model “${s.model}” is available.` : `Connected, but model “${s.model}” is not pulled. Run: ollama pull ${s.model}`;
}
