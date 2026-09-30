// Shared helpers: DOM, dates, formatting.

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- dates (local calendar, YYYY-MM-DD)
const pad = (n) => String(n).padStart(2, '0');
export const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseDate = (ymd) => { const [y, m, d] = ymd.split('-'); return new Date(+y, +m - 1, +d); };
export const addDays = (ymd, n) => { const d = parseDate(ymd); d.setDate(d.getDate() + n); return todayStr(d); };
const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const dayName = (ymd) => DAYS[parseDate(ymd).getDay()];
export const shortDate = (ymd) => { const [, m, d] = ymd.split('-'); return `${d}/${m}`; };
export const longDate = (ymd) => { const [y, m, d] = ymd.split('-'); return `יום ${dayName(ymd)} ${d}/${m}/${y}`; };

// Period = { p: 'day' | 'week' | 'month', d: any date inside it }. Weeks run Sunday → Saturday.
export function periodRange({ p, d }) {
  if (p === 'day') return { from: d, to: d };
  if (p === 'week') { const from = addDays(d, -parseDate(d).getDay()); return { from, to: addDays(from, 6) }; }
  const dt = parseDate(d);
  return { from: todayStr(new Date(dt.getFullYear(), dt.getMonth(), 1)), to: todayStr(new Date(dt.getFullYear(), dt.getMonth() + 1, 0)) };
}
export function stepPeriod({ p, d }, dir) {
  if (p === 'day') return { p, d: addDays(d, dir) };
  if (p === 'week') return { p, d: addDays(d, 7 * dir) };
  const dt = parseDate(d);
  return { p, d: todayStr(new Date(dt.getFullYear(), dt.getMonth() + dir, 1)) };
}
export function periodLabel(per) {
  const t = todayStr();
  const { from, to } = periodRange(per);
  if (per.p === 'day') {
    const rel = { [t]: 'היום', [addDays(t, -1)]: 'אתמול', [addDays(t, 1)]: 'מחר' }[per.d];
    return (rel ? rel + ' · ' : '') + longDate(per.d);
  }
  if (per.p === 'week') return `${from <= t && t <= to ? 'השבוע · ' : ''}${shortDate(from)} – ${shortDate(to)}/${to.slice(0, 4)}`;
  const name = parseDate(from).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
  return `${from <= t && t <= to ? 'החודש · ' : ''}${name}`;
}
export const eachDay = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };

// ---------------------------------------------------------------- formatting
export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}
export function fmtStamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${fmtTime(ts)}`;
}
export function fmtAgo(ts) {
  if (!ts) return 'אף פעם';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'עכשיו';
  if (s < 3600) return `לפני ${Math.round(s / 60)} דק׳`;
  if (s < 86400) return `לפני ${Math.round(s / 3600)} ש׳`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'אתמול' : `לפני ${days} ימים`;
}
export function fmtDuration(ms) {
  if (ms == null || ms <= 0) return '—';
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} דק׳` : `${Math.floor(min / 60)}:${pad(min % 60)} ש׳`;
}
export const fmtAddress = (d) => `${(d.street || '').trim()} ${(d.houseNo || '').trim()}, ${(d.city || '').trim()}`.replace(/\s+,/, ',').trim();
export const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0;
  const out = [], factor = 10 ** precision;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, b;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    out.push([lat / factor, lng / factor]);
  }
  return out;
}

export const prefs = {
  get(k, def) { try { const v = localStorage.getItem('srAdmin.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('srAdmin.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
