'use strict';
(function(root) {
  function dateKey(item) {
    const key = item.captureDate || item.capturedAt?.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key || '')) return null;
    const parsed = new Date(key + 'T12:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === key ? key : null;
  }
  function dateLabel(key) {
    if (!key) return '日期未知';
    const [year, month, day] = key.split('-');
    return `${year}年${Number(month)}月${Number(day)}日`;
  }
  function captureLabel(item) {
    const day = dateKey(item);
    const clock = day && item.capturedAt?.match(/T(\d{2}:\d{2}(?::\d{2})?)/)?.[1];
    return dateLabel(day) + (clock ? ` ${clock}` : '');
  }
  function group(items) {
    const grouped = new Map();
    for (const item of items) {
      const key = dateKey(item) || '';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    }
    return [...grouped.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([date, entries]) => ({
      date: date || null,
      items: entries.sort((left, right) => (right.capturedAt || '').localeCompare(left.capturedAt || '') || left.id.localeCompare(right.id))
    }));
  }
  const api = { dateKey, dateLabel, captureLabel, group };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PhotoDates = api;
})(typeof window !== 'undefined' ? window : globalThis);
