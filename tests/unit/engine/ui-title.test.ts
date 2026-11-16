import { displayTitle } from '../../../src/lib/meta';
it('cleans YouTube SEO suffixes only', () => {
  expect(displayTitle({ provider: 'youtube', title: 'A.R.P.U. | British Short Film | Science Fiction' })).toBe('A.R.P.U.');
  expect(displayTitle({ provider: 'youtube', title: 'Drifters | Sci-Fi Short Film | DUST' })).toBe('Drifters');
  expect(displayTitle({ provider: 'youtube', title: 'Rise of the Ottoman Empire - From Kosovo to Constantinople DOCUMENTARY' })).toBe('Rise of the Ottoman Empire');
  expect(displayTitle({ provider: 'spotify', title: 'Pal Pal - Live | Remix' })).toBe('Pal Pal - Live | Remix');
});
