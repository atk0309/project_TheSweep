// Extract the 48 teams + their EXACT flag gradients from the design file, so the
// DB seed is byte-identical to the handoff. Reads the `raw` array + `gf()` recipe
// from Sweepstake.dc.html and emits server/teams.seed.json.
import { readFile, writeFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/Sweepstake.dc.html', import.meta.url), 'utf8');

const start = html.indexOf('const raw = [');
if (start === -1) throw new Error('could not find `const raw = [` in design file');
const end = html.indexOf('];', start);
const rawText = html.slice(start + 'const raw = '.length, end + 1); // includes closing ]

// eslint-disable-next-line no-new-func — evaluating a pure literal data array we extracted
const raw = Function(`return (${rawText});`)();

// gf(): identical to the design's gradient recipe.
const gf = (c, d) => {
  const a = d === 'v' ? '90deg' : '180deg';
  if (c.length === 3) return `linear-gradient(${a},${c[0]} 0 33.34%,${c[1]} 33.34% 66.67%,${c[2]} 66.67% 100%)`;
  return `linear-gradient(${a},${c[0]} 0 50%,${c[1]} 50% 100%)`;
};
const G = 'ABCDEFGHIJKL';

const teams = raw.map((r, i) => ({
  idx: i,
  code: r[0],
  name: r[1],
  group_letter: G[Math.floor(i / 4)],
  flag: gf(r[2], r[3]),
}));

if (teams.length !== 48) throw new Error(`expected 48 teams, got ${teams.length}`);

await writeFile(new URL('../server/teams.seed.json', import.meta.url), JSON.stringify(teams, null, 2) + '\n');
console.log(`wrote server/teams.seed.json: ${teams.length} teams`);

// Also emit a colour map (normalised country name -> {c: colours, d: orientation})
// so the poller can render a flag gradient for whatever real teams the API returns.
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const colors = {};
raw.forEach((r) => { colors[norm(r[1])] = { c: r[2], d: r[3] }; });
// hand-added aliases + a few likely-2026 nations the design's 48 don't cover
const extra = {
  unitedstates: colors['usa'], koreyarepublic: colors['southkorea'], korearepublic: colors['southkorea'],
  ivorycoast: colors['cotedivoire'], turkey: colors['turkiye'], iran: { c: ['#239f40', '#ffffff', '#da0000'], d: 'h' },
  jordan: { c: ['#000000', '#ffffff', '#007a3d'], d: 'h' }, uzbekistan: { c: ['#1eb53a', '#ffffff', '#0099b5'], d: 'h' },
  capeverde: { c: ['#003893', '#ffffff', '#cf2027'], d: 'h' }, newzealand: { c: ['#00247d', '#ffffff'], d: 'h' },
  southafrica: { c: ['#007749', '#ffb612', '#000000'], d: 'h' }, jamaica: { c: ['#009b3a', '#fed100', '#000000'], d: 'h' },
  haiti: { c: ['#00209f', '#d21034'], d: 'h' }, curacao: { c: ['#002b7f', '#f9d90f'], d: 'h' },
  newcaledonia: { c: ['#0035ad', '#ed4135', '#009543'], d: 'h' }, czechia: { c: ['#11457e', '#ffffff', '#d7141a'], d: 'h' },
  ukraine: colors['ukraine'], bolivia: { c: ['#d52b1e', '#f9e300', '#007934'], d: 'h' },
  venezuela: { c: ['#ffce00', '#00247d', '#cf142b'], d: 'h' }, iraq: { c: ['#ce1126', '#ffffff', '#000000'], d: 'h' },
};
Object.assign(colors, extra);
await writeFile(new URL('../server/country_colors.json', import.meta.url), JSON.stringify(colors, null, 0) + '\n');
console.log(`wrote server/country_colors.json: ${Object.keys(colors).length} entries`);
console.log('sample:', JSON.stringify(teams[0]));
console.log('group A:', teams.slice(0, 4).map((t) => t.code).join(', '));
console.log('group L:', teams.slice(44, 48).map((t) => t.code).join(', '));
console.log('curly-apostrophe check:', teams.find((t) => t.code === 'CIV')?.name);
