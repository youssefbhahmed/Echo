// Small synthetic Exportify-style library (made-up ids, titles and artists) for lane tests.
export const HEADER = 'Track URI,ISRC,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Popularity,Explicit,Added By,Added At,Genres,Record Label,Danceability,Energy,Key,Loudness,Mode,Speechiness,Acousticness,Instrumentalness,Liveness,Valence,Tempo,Time Signature';

interface Group {
  name: string;
  n: number;
  genres: string;
  years: [number, number];
  added: string;
  pop: number;
  f: { dance: number; energy: number; loud: number; speech: number; acoustic: number; instr: number; valence: number; tempo: number };
}

let counter = 0;
const id = () => (counter++).toString(36).toUpperCase().padStart(22, 'Z').slice(-22);
// Deterministic jitter so neighbours are not all identical.
const jitter = (i: number, k: number) => ((((i + 1) * 9301 + k * 49297) % 233280) / 233280 - 0.5) * 0.06;

export const GROUPS: Group[] = [
  { name: 'Hiphop', n: 24, genres: 'rap,hip-hop,r&b', years: [2012, 2024], added: '2026-06-01T00:00:00Z', pop: 58, f: { dance: 0.8, energy: 0.65, loud: -6, speech: 0.25, acoustic: 0.1, instr: 0, valence: 0.5, tempo: 95 } },
  { name: 'Rock', n: 14, genres: 'rock,metal alternatif', years: [2001, 2015], added: '2024-03-01T00:00:00Z', pop: 55, f: { dance: 0.4, energy: 0.9, loud: -4, speech: 0.05, acoustic: 0.02, instr: 0.01, valence: 0.35, tempo: 135 } },
  { name: 'House', n: 12, genres: 'afro house,house organique,downtempo', years: [2016, 2025], added: '2026-09-01T00:00:00Z', pop: 45, f: { dance: 0.75, energy: 0.7, loud: -8, speech: 0.05, acoustic: 0.15, instr: 0.3, valence: 0.25, tempo: 122 } },
  // French songs sound like the hip-hop ones: untagged songs must still never be placed here.
  { name: 'French', n: 16, genres: 'pop urbaine,rap français', years: [2008, 2022], added: '2026-01-01T00:00:00Z', pop: 52, f: { dance: 0.78, energy: 0.63, loud: -6.2, speech: 0.23, acoustic: 0.12, instr: 0, valence: 0.48, tempo: 97 } },
  { name: 'Arabic', n: 10, genres: 'hip-hop arabe,rap marocain', years: [2018, 2025], added: '2026-10-01T00:00:00Z', pop: 30, f: { dance: 0.7, energy: 0.6, loud: -7, speech: 0.2, acoustic: 0.2, instr: 0, valence: 0.55, tempo: 100 } },
  { name: 'Gnawa', n: 6, genres: 'gnaoui', years: [1975, 2021], added: '2025-12-01T00:00:00Z', pop: 25, f: { dance: 0.6, energy: 0.5, loud: -9, speech: 0.08, acoustic: 0.5, instr: 0.1, valence: 0.6, tempo: 110 } },
  { name: 'Jazz', n: 3, genres: 'jazz', years: [1959, 1965], added: '2020-01-01T00:00:00Z', pop: 40, f: { dance: 0.45, energy: 0.3, loud: -14, speech: 0.04, acoustic: 0.85, instr: 0.8, valence: 0.4, tempo: 120 } },
  // Untagged songs: most sound like the hip-hop lane, some like rock.
  { name: 'UntaggedUrban', n: 30, genres: '', years: [2015, 2025], added: '2026-08-01T00:00:00Z', pop: 62, f: { dance: 0.79, energy: 0.64, loud: -6.1, speech: 0.24, acoustic: 0.11, instr: 0, valence: 0.49, tempo: 96 } },
  { name: 'UntaggedRock', n: 8, genres: '', years: [2005, 2018], added: '2023-05-01T00:00:00Z', pop: 50, f: { dance: 0.41, energy: 0.88, loud: -4.2, speech: 0.05, acoustic: 0.03, instr: 0.01, valence: 0.36, tempo: 133 } },
];

export function syntheticCsv(groups: Group[] = GROUPS): string {
  counter = 0;
  const rows: string[] = [HEADER];
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const y = g.years[0] + Math.round(((g.years[1] - g.years[0]) * i) / Math.max(1, g.n - 1));
      const j = (k: number) => jitter(i, k);
      const f = g.f;
      rows.push([
        `spotify:track:${id()}`, 'XX0000000000', `"${g.name} Song ${i}"`, `"${g.name} Album"`, `"${g.name} Artist ${i}"`, `${y}-05-01`, '210000', String(g.pop + (i % 5) - 2), 'false', 'u', g.added,
        `"${g.genres}"`, '"Label"', (f.dance + j(1)).toFixed(3), (f.energy + j(2)).toFixed(3), '0', (f.loud + j(3) * 10).toFixed(2), '1', (f.speech + j(4) / 3).toFixed(3),
        (f.acoustic + j(5) / 3).toFixed(3), Math.max(0, f.instr + j(6) / 3).toFixed(3), '0.1', (f.valence + j(7)).toFixed(3), (f.tempo + j(8) * 30).toFixed(1), '4',
      ].join(','));
    }
  }
  return rows.join('\n');
}
