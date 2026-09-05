// Storage measurement for W19: pretty (2-space) vs minified raw sidecars.
//   node perf/storage-sidecars.mjs
// Builds realistically-shaped openbook + thunder records (mirrors perf/gen.mjs's
// synthetic openbook scale) and reports the byte cost of pretty-printing each.

const spine = [];
const cmpts = [];
for (let i = 0; i < 400; i++) {
  spine.push({
    path: `res/part${i + 1}.mp3`,
    '-odread-spine-position': i,
    '-odread-original-path': `Part ${i + 1}.mp3`,
    '-odread-file-bytes': 5_000_000 + i,
    'audio-duration': 600 + i,
    'media-type': 'audio/mpeg',
  });
  cmpts.push(`cmpt=${i}`);
}
const openbook = {
  title: { main: 'Bench Openbook' },
  description: { full: 'x'.repeat(1_700_000) },
  spine,
  '-odread-cmpt-params': cmpts,
  nav: { toc: spine.slice(0, 50).map((p, i) => ({ title: `Chapter ${i}`, path: p.path })) },
  creator: [{ name: 'A. Author', role: 'author' }],
};
const thunder = {
  id: '101',
  publisher: { name: 'Test Press' },
  subjects: Array.from({ length: 60 }, (_, i) => ({ name: `subject-${i}`, id: 1000 + i })),
  formats: Array.from({ length: 6 }, (_, i) => ({
    id: `ebook-${i}`,
    identifiers: [{ type: 'ISBN', value: `978-0-000-0000-${i}` }, { type: 'DOI', value: `10.1000/0000.${i}` }],
  })),
  covers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`c${i}`, { href: `/ImageType-100/${i}`, width: 300 * i }])),
  starRating: 4.5,
  starRatingCount: 12345,
  languages: [{ id: 'en', name: 'English' }],
};

const row = (name, doc) => {
  const pretty = Buffer.byteLength(JSON.stringify(doc, null, 2));
  const raw = Buffer.byteLength(JSON.stringify(doc));
  console.log(JSON.stringify({ sidecar: name, prettyBytes: pretty, rawBytes: raw, savedPct: Math.round((1 - raw / pretty) * 100) }));
};
row('openbook.json (magazine-scale, ~1.9 MB)', openbook);
row('thunder.json (rich catalog record)', thunder);
