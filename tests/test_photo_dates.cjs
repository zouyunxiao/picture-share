const assert = require('node:assert/strict');
const dates = require('../outputs/media-site/public/photo-dates.js');
const items = [
  { id: 'late-upload-old', capturedAt: '2025-03-01T09:00:00+08:00', captureDate: '2025-03-01', createdAt: '2026-11-10T12:00:00Z' },
  { id: 'known-2', capturedAt: '2026-11-01T00:10:00+09:00', captureDate: '2026-11-01', createdAt: '2025-01-01T00:00:00Z' },
  { id: 'unknown', capturedAt: null, createdAt: '2026-11-11T00:00:00Z' },
  { id: 'known-1', capturedAt: '2026-11-01T14:30:00+09:00', captureDate: '2026-11-01' },
  { id: 'leap', capturedAt: '2024-02-29T12:00:00' }
];
const result = dates.group(items);
assert.deepEqual(result.map(g => g.date), ['2026-11-01', '2025-03-01', '2024-02-29', null]);
assert.deepEqual(result[0].items.map(i => i.id), ['known-1','known-2']);
assert.equal(dates.dateLabel(result[0].date), '2026年11月1日');
assert.equal(dates.dateKey(items[1]), '2026-11-01'); // UTC would be October 31.
assert.equal(dates.captureLabel(items[1]), '2026年11月1日 00:10:00');
assert.equal(dates.dateKey({captureDate:'2025-02-29'}), null);
assert.equal(dates.captureLabel(items[2]), '日期未知');
assert.equal(items[0].id, 'late-upload-old');
assert.deepEqual(dates.group([]), []);
console.log(JSON.stringify({passed:9,checks:'capture-day grouping, capture-time sort, no upload-date fallback, timezone-safe date, leap date validation, unknown dates last, stable input and empty collection'}));
