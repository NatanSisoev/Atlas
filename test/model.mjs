// node test/model.mjs — unit tests for the shared model (model/time.js, model/view.js, model/urls.js).
import assert from 'node:assert/strict';
import { DAY_START_HOUR, localDay, todayYmd, formatPlate, formatRange, chapterStatus, formatTime } from '../model/time.js';
import { isCuratedNames, draftFolderChapter } from '../model/view.js';
import { safeMediaPath } from '../model/urls.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
  }
}

/** Fixture item: id 'l:<name>', index parsed from a leading "NNNN_". */
const item = (name, takenLocal, kind = 'photo', index = /^(\d+)_/.exec(name)?.[1]) =>
  ({ id: `l:${name}`, name, index: index == null ? null : Number(index), takenLocal, kind });
const ids = (pages) => pages.map((p) => p.items.map((id) => id.slice(2)));

console.log('model');

test('localDay: 04:00 boundary (03:59 belongs to the previous day)', () => {
  assert.equal(DAY_START_HOUR, 4);
  assert.equal(localDay('2025-08-12T04:00:00'), '2025-08-12');
  assert.equal(localDay('2025-08-12T03:59:59'), '2025-08-11');
  assert.equal(localDay('2025-08-12T00:00:00'), '2025-08-11');
  assert.equal(localDay('2025-08-12T23:59:59'), '2025-08-12');
  assert.equal(localDay('2025-09-01T02:10:00'), '2025-08-31');
  assert.equal(localDay('2026-01-01T01:00:00'), '2025-12-31');
  assert.equal(localDay('2024-03-01T03:00:00'), '2024-02-29');
});

test('localDay: offsets and naive strings use the wall clock as written', () => {
  assert.equal(localDay('2025-08-12T15:00:19+03:00'), '2025-08-12');
  assert.equal(localDay('2025-08-12T15:00:19'), '2025-08-12');
  assert.equal(localDay('2025-08-12T02:00:00+03:00'), '2025-08-11');
  assert.equal(localDay('2025-08-12T23:30:00-07:00'), '2025-08-12');
  assert.equal(localDay('2025-08-12T23:30:00Z'), '2025-08-12');
  assert.equal(localDay('2025-08-12T15:00:19.250+0300'), '2025-08-12');
  assert.equal(localDay('2025-08-12 15:00'), '2025-08-12');
  assert.equal(localDay('2025-08-12'), '2025-08-12', 'a date alone is already a day');
});

test('localDay: invalid input gives null', () => {
  for (const bad of [null, undefined, '', 'yesterday', 42, {}, '2025-13-01T10:00:00', '2025-02-30T10:00:00',
    '2025-08-12T24:00:00', '2025-08-12T10:60:00', '2025:08:12 15:00:19', '12/08/2025']) {
    assert.equal(localDay(bad), null, String(bad));
  }
});

test('todayYmd: uses the local clock with the 04:00 boundary', () => {
  assert.equal(todayYmd(new Date(2025, 7, 12, 3, 59)), '2025-08-11');
  assert.equal(todayYmd(new Date(2025, 7, 12, 4, 0)), '2025-08-12');
  assert.match(todayYmd(), /^\d{4}-\d{2}-\d{2}$/);
});

test('formatPlate', () => {
  assert.deepEqual(formatPlate('2025-08-12'), { weekday: 'TUE', day: '12', month: 'AUG', long: 'Tue 12 Aug', full: 'Tuesday 12 August 2025' });
  assert.deepEqual(formatPlate('2026-01-03'), { weekday: 'SAT', day: '3', month: 'JAN', long: 'Sat 3 Jan', full: 'Saturday 3 January 2026' });
  assert.equal(formatPlate(null), null);
  assert.equal(formatPlate('2025-08-12T10:00:00'), null);
  assert.equal(formatPlate('2025-02-29'), null);
});

test('formatRange: same month, cross-month, cross-year, single day, null', () => {
  assert.equal(formatRange('2025-08-10', '2025-08-14'), '10–14 Aug 2025');
  assert.equal(formatRange('2025-08-30', '2025-09-02'), '30 Aug – 2 Sep 2025');
  assert.equal(formatRange('2025-12-28', '2026-01-03'), '28 Dec 2025 – 3 Jan 2026');
  assert.equal(formatRange('2025-08-12', '2025-08-12'), '12 Aug 2025');
  assert.equal(formatRange('2025-08-12', null), '12 Aug 2025');
  assert.equal(formatRange(null, '2025-08-12'), '12 Aug 2025');
  assert.equal(formatRange('2025-08-14', '2025-08-10'), '10–14 Aug 2025', 'reversed ends are put in order');
  assert.equal(formatRange(null, null), null);
  assert.equal(formatRange('nonsense', undefined), null);
});

test('chapterStatus', () => {
  assert.equal(chapterStatus('2025-08-10', '2025-08-14', '2025-08-09'), 'upcoming');
  assert.equal(chapterStatus('2025-08-10', '2025-08-14', '2025-08-10'), 'ongoing');
  assert.equal(chapterStatus('2025-08-10', '2025-08-14', '2025-08-14'), 'ongoing');
  assert.equal(chapterStatus('2025-08-10', '2025-08-14', '2025-08-15'), 'past');
  assert.equal(chapterStatus('2025-08-10', null, '2025-08-11'), 'past');
  assert.equal(chapterStatus(null, null, '2025-08-11'), 'someday');
});

test('formatTime', () => {
  assert.equal(formatTime('2025-08-12T15:00:19+03:00'), '15:00');
  assert.equal(formatTime('2025-08-12T03:07:00'), '03:07');
  assert.equal(formatTime('2025-08-12'), null);
  assert.equal(formatTime('garbage'), null);
  assert.equal(formatTime(null), null);
});

test('isCuratedNames: 80% threshold', () => {
  const numbered = (n) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, '0')}_x.jpg`);
  assert.equal(isCuratedNames([...numbered(8), 'IMG_1.jpg', 'IMG_2.jpg']), true, '8 of 10');
  assert.equal(isCuratedNames([...numbered(7), 'IMG_1.jpg', 'IMG_2.jpg', 'IMG_3.jpg']), false, '7 of 10');
  assert.equal(isCuratedNames(['0001_a.jpg']), true);
  assert.equal(isCuratedNames(['GX010042.MP4', 'IMG_20250812.jpg']), false);
  assert.equal(isCuratedNames(['0001a.jpg', '_0002.jpg']), false, 'needs digits then underscore');
  assert.equal(isCuratedNames([]), false);
});

test('draftFolderChapter: curated filename order beats time order; pages break on day change', () => {
  const items = [
    item('0003_dinner.jpg', '2025-08-11T21:00:00'),
    item('0001_arrival.jpg', '2025-08-12T10:00:00'),
    item('0002_late_walk.mp4', '2025-08-13T02:30:00', 'video'),
    item('0004_morning.jpg', '2025-08-13T09:00:00+03:00'),
  ];
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 'Holiday', items, curated: true, today: '2026-01-01' });
  assert.deepEqual(ids(pages), [['0001_arrival.jpg', '0002_late_walk.mp4'], ['0003_dinner.jpg'], ['0004_morning.jpg']]);
  assert.deepEqual(pages.map((p) => p.date), ['2025-08-12', '2025-08-11', '2025-08-13']);
  assert.deepEqual(pages.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(chapter, {
    id: 'folder', title: 'Holiday', from: '2025-08-11', to: '2025-08-13', status: 'past',
    coverId: 'l:0001_arrival.jpg', itemCount: 4, pageCount: 3,
  });
});

test('draftFolderChapter: going back to an earlier day starts its own page', () => {
  const items = [
    item('0001_a.jpg', '2025-08-12T10:00:00'),
    item('0002_b.jpg', '2025-08-13T10:00:00'),
    item('0003_c.jpg', '2025-08-12T18:00:00'),
    item('0004_d.jpg', '2025-08-12T19:00:00'),
  ];
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 't', items, curated: true, today: '2025-08-13' });
  assert.deepEqual(pages.map((p) => p.date), ['2025-08-12', '2025-08-13', '2025-08-12']);
  assert.deepEqual(ids(pages), [['0001_a.jpg'], ['0002_b.jpg'], ['0003_c.jpg', '0004_d.jpg']]);
  assert.equal(chapter.status, 'ongoing');
});

test('draftFolderChapter: undated items stay on the current page; leading undated form a null page', () => {
  const items = [
    item('0001_x.jpg', null),
    item('0002_y.jpg', 'not a date'),
    item('0003_a.jpg', '2025-08-12T10:00:00'),
    item('0004_u.jpg', null),
    item('0005_b.jpg', '2025-08-12T11:00:00'),
    item('0006_c.jpg', '2025-08-13T11:00:00'),
    item('0007_v.jpg', undefined),
  ];
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 't', items, curated: true, today: '2025-08-01' });
  assert.deepEqual(pages.map((p) => p.date), [null, '2025-08-12', '2025-08-13']);
  assert.deepEqual(ids(pages), [['0001_x.jpg', '0002_y.jpg'], ['0003_a.jpg', '0004_u.jpg', '0005_b.jpg'], ['0006_c.jpg', '0007_v.jpg']]);
  assert.equal(chapter.from, '2025-08-12');
  assert.equal(chapter.to, '2025-08-13');
  assert.equal(chapter.status, 'upcoming');
});

test('draftFolderChapter: curated items without an index follow the numbered ones by name', () => {
  const items = [item('zeta.jpg', null), item('0010_b.jpg', null), item('0002_a.jpg', null), item('alpha.jpg', null)];
  const { pages } = draftFolderChapter({ id: 'folder', title: 't', items, curated: true, today: '2025-08-01' });
  assert.deepEqual(ids(pages), [['0002_a.jpg', '0010_b.jpg', 'alpha.jpg', 'zeta.jpg']]);
});

test('draftFolderChapter: cover is the first photo, else the first item', () => {
  const vids = [item('0001_v.mp4', '2025-08-12T10:00:00', 'video'), item('0002_w.mp4', '2025-08-12T11:00:00', 'video')];
  const mixed = [...vids, item('0003_p.jpg', '2025-08-12T12:00:00')];
  assert.equal(draftFolderChapter({ id: 'f', title: 't', items: mixed, curated: true, today: '2026-01-01' }).chapter.coverId, 'l:0003_p.jpg');
  assert.equal(draftFolderChapter({ id: 'f', title: 't', items: vids, curated: true, today: '2026-01-01' }).chapter.coverId, 'l:0001_v.mp4');
});

test('draftFolderChapter: empty folder', () => {
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 'Empty', items: [], curated: false, today: '2026-01-01' });
  assert.deepEqual(pages, []);
  assert.deepEqual(chapter, { id: 'folder', title: 'Empty', from: null, to: null, status: 'someday', coverId: null, itemCount: 0, pageCount: 0 });
});

test('draftFolderChapter: non-curated folders read by time (wall clock), undated last, ties by name', () => {
  const items = [
    item('IMG_9.jpg', null),
    item('GX010042.MP4', '2025-08-13T09:00:00', 'video'),
    item('IMG_10.jpg', '2025-08-12T15:00:00+03:00'),
    item('IMG_2.jpg', '2025-08-12T15:00:00'),
    item('IMG_1.jpg', '2025-08-12T09:00:00-05:00'),
    item('IMG_3.jpg', '2025-08-13T03:00:00'),
  ];
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 'Roll', items, curated: false, today: '2026-01-01' });
  assert.deepEqual(ids(pages), [['IMG_1.jpg', 'IMG_2.jpg', 'IMG_10.jpg', 'IMG_3.jpg'], ['GX010042.MP4', 'IMG_9.jpg']]);
  assert.deepEqual(pages.map((p) => p.date), ['2025-08-12', '2025-08-13']);
  assert.equal(chapter.coverId, 'l:IMG_1.jpg');
  assert.equal(chapter.itemCount, 6);
  assert.equal(chapter.pageCount, 2);
});

test('draftFolderChapter: curated numbered subfolders read folder by folder, never interleaved', () => {
  const sub = (dir, name, takenLocal) => ({ ...item(name, takenLocal), id: `l:${dir}/${name}`, dir });
  const items = [
    sub('2025 Black Sea', '0001_c.jpg', '2025-08-12T10:00:00'),
    sub('2024 Portugal', '0002_b.jpg', '2024-06-03T10:00:00'),
    sub('2025 Black Sea', '0002_d.jpg', '2025-08-13T10:00:00'),
    sub('2024 Portugal', '0001_a.jpg', '2024-06-01T10:00:00'),
  ];
  const { chapter, pages } = draftFolderChapter({ id: 'folder', title: 'Trips', items, curated: true, today: '2026-01-01' });
  assert.deepEqual(pages.map((p) => p.items.map((id) => id.slice(2))), [
    ['2024 Portugal/0001_a.jpg'],
    ['2024 Portugal/0002_b.jpg'],
    ['2025 Black Sea/0001_c.jpg'],
    ['2025 Black Sea/0002_d.jpg'],
  ]);
  assert.deepEqual([chapter.from, chapter.to], ['2024-06-01', '2025-08-13']);
  // Folder names compare numerically ("day 2" before "day 10"); files at the root come first.
  const days = [sub('day 10', '0001_x.jpg', null), sub('day 2', '0001_y.jpg', null), { ...item('0005_root.jpg', null), dir: '' }];
  const order = draftFolderChapter({ id: 'f', title: '', items: days, curated: true, today: '2026-01-01' }).pages.flatMap((p) => p.items);
  assert.deepEqual(order, ['l:0005_root.jpg', 'l:day 2/0001_y.jpg', 'l:day 10/0001_x.jpg']);
});

test('safeMediaPath: only same-origin /media/ paths pass', () => {
  const origin = 'https://atlas.tailnet.ts.net';
  for (const bad of [
    '/\t/evil.example/x', '/\n/evil.example/x', '/\r/evil.example/x', '/\t/evil.example/x.jpg', '//evil.example/x', '/\\evil.example/x',
    'https://evil.example/x', 'javascript:alert(1)', '/api/x', '/media/../api/x', 'media/local/x', '', null, 42, '/media/local/x\u0000',
  ]) {
    assert.equal(safeMediaPath(bad, origin), '', JSON.stringify(bad));
  }
  assert.equal(safeMediaPath('/media/local/thumb/a%20b.jpg?w=400&v=1', origin), '/media/local/thumb/a%20b.jpg?w=400&v=1');
  assert.equal(safeMediaPath('/media/local/original/day%20two/0003_sunset_%C3%A9.png?download=1', origin), '/media/local/original/day%20two/0003_sunset_%C3%A9.png?download=1');
  assert.equal(safeMediaPath('/media/local/display/x.mp4'), '/media/local/display/x.mp4', 'works without a page origin');
});

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
