import { createData, statsOf } from './data.js';
import { SUPERADMIN, APP, magicLink, registrationLink } from './config.js';
import {
  $, el, esc, todayStr, addDays, parseDate, dayName, shortDate, longDate, periodRange, stepPeriod, periodLabel, eachDay,
  fmtTime, fmtStamp, fmtAgo, fmtDuration, fmtAddress, pct, initials, decodePolyline,
} from './util.js';

// ------------------------------------------------------------------ constants
const STATUS = {
  pending:         { label: 'ממתין',         icon: '⏳', cls: 'pending' },
  no_answer_temp:  { label: 'לא ענה – זמני', icon: '📵', cls: 'temp' },
  delivered_hand:  { label: 'נמסר ביד',      icon: '🤝', cls: 'ok', final: true },
  delivered_door:  { label: 'נמסר ליד הדלת', icon: '🚪', cls: 'ok', final: true },
  no_answer_final: { label: 'לא ענה – סופי', icon: '❌', cls: 'fail', final: true },
};
const COLORS = { ok: '#16a34a', fail: '#dc2626', temp: '#d97706', pending: '#2563eb', me: '#7c3aed' };
const PERIODS = [['day', 'יום'], ['week', 'שבוע'], ['month', 'חודש']];

// ------------------------------------------------------------------ state
const A = {
  data: null, me: null,
  role: null,          // 'super' | 'admin' – only these two may use the panel
  app: APP,
  users: [], usersLoaded: false,   // members merged with their app profiles
  profiles: [], members: {}, membersLoaded: false,
  invites: [], refs: {}, regs: [], regsLoaded: false,
  listeners: [],       // app-wide (profiles, members, invites, refs, registrations)
  view: { id: 0, unsubs: [], maps: [], timer: null, onUsers: null, onData: null },
  usersFilter: { q: '', show: 'all' },
  regsFilter: { status: 'open', q: '' },
};

const isSuper = () => A.role === 'super';
const isDisabled = (uid) => A.members[uid]?.disabled === true;
const roleOf = (uid) => (A.users.find((u) => u.id === uid)?.email === SUPERADMIN ? 'super' : A.members[uid]?.role === 'admin' ? 'admin' : A.members[uid] ? 'user' : 'none');
const userById = (uid) => A.users.find((u) => u.id === uid);
const nameOf = (uid) => (uid === 'superadmin' ? 'מנהל ראשי' : userById(uid)?.name || userById(uid)?.email || A.members[uid]?.name || '—');
// Superadmin: anyone but themselves. Admin: regular users only (never admins / the superadmin / themselves).
const canToggle = (uid) => uid !== A.me.uid && roleOf(uid) !== 'super' && (isSuper() || roleOf(uid) === 'user') && !!A.members[uid];
const refOf = (ref) => A.refs[String(ref || '').trim().toLowerCase()] || null;

async function copyText(text, msg = 'הועתק ✓') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { window.prompt('העתק:', text); }
}
// 050-1234567 → https://wa.me/972501234567?text=…
const waLink = (mobile, text) => `https://wa.me/${mobile ? '972' + String(mobile).replace(/\D/g, '').replace(/^0/, '') : ''}?text=${encodeURIComponent(text)}`;
const inviteText = (url, name) => `היי${name ? ' ' + name : ''}! 👋\nזה הקישור שלך להצטרפות ל-SmartRoute – סידור מסלול משלוחים חכם:\n${url}\nנכנסים עם חשבון Google וזהו.`;
const done = (s) => (s?.delivered || 0) + (s?.noAnswer || 0);
const left = (s) => (s?.pending || 0) + (s?.temp || 0);

function toast(msg, { err = false, ms = 3500 } = {}) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toast._t);
  if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
}

function explainError(e) {
  console.error(e);
  if (e?.code === 'permission-denied') return 'אין הרשאה לקרוא את הנתונים. ודא שכללי firestore.rules המעודכנים פורסמו ושהחשבון שלך מוגדר כמנהל.';
  return 'שגיאה: ' + (e?.message || e);
}

// ------------------------------------------------------------------ dialog
function dialog({ title, body, okText = 'אישור', danger = false, note = null, value = '' }) {
  return new Promise((resolve) => {
    const input = note ? el('textarea', { rows: 2, placeholder: note }) : null;
    if (input) input.value = value;
    const finish = (v) => { box.remove(); resolve(v); };
    const box = el('div', { class: 'overlay' }, el('div', { class: 'dialog', role: 'dialog' },
      el('h2', {}, title),
      body ? (typeof body === 'string' ? el('p', {}, body) : body) : null,
      input ? el('label', { class: 'field' }, 'הערה (לא חובה)', input) : null,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => finish({ note: input?.value.trim() || '' }) }, okText),
        el('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, 'ביטול'))));
    box.addEventListener('click', (e) => { if (e.target === box) finish(null); });
    document.body.append(box);
    (input || box.querySelector('.btn')).focus();
  });
}

async function toggleAccess(u) {
  if (!canToggle(u.id)) return toast('אין לך הרשאה לשנות את המשתמש הזה', { err: true });
  const disable = !isDisabled(u.id);
  const name = u.name || u.email || u.id;
  const ok = await dialog({
    title: disable ? `להשבית את ${name}?` : `להפעיל מחדש את ${name}?`,
    body: disable
      ? 'המשתמש לא יוכל לקרוא או לשנות את הנתונים שלו ב-SmartRoute עד שתפעיל אותו מחדש. הנתונים עצמם לא נמחקים.'
      : 'המשתמש יחזור לעבוד כרגיל ב-SmartRoute.',
    okText: disable ? '⛔ השבת' : '✓ הפעל', danger: disable, note: disable ? 'למשל: סיים לעבוד' : null,
  });
  if (!ok) return;
  try {
    await A.data.setMember(u.id, { disabled: disable, note: disable ? ok.note : '' });
    toast(disable ? `${name} הושבת` : `${name} הופעל מחדש ✓`);
  } catch (e) { toast(explainError(e), { err: true, ms: 8000 }); }
}

// Superadmin only: make someone an admin, or back to a regular user.
async function changeRole(u, role) {
  if (!isSuper() || roleOf(u.id) === 'super' || !A.members[u.id]) return;
  const name = u.name || u.email || u.id;
  const ok = await dialog({
    title: role === 'admin' ? `להפוך את ${name} למנהל?` : `להחזיר את ${name} למשתמש רגיל?`,
    body: role === 'admin'
      ? 'מנהל נכנס לפאנל הזה, רואה את כל המשתמשים וההרשמות, יכול להשבית משתמשים רגילים ומקבל קישור הזמנה משלו. הוא לא יכול למנות מנהלים.'
      : 'המשתמש יאבד את הגישה לפאנל הניהול. קישורי ההזמנה שלו יכובו.',
    okText: role === 'admin' ? '👑 מנה למנהל' : 'הפוך למשתמש', danger: role !== 'admin',
  });
  if (!ok) return;
  try {
    await A.data.setMember(u.id, { role });
    if (role === 'admin' && !A.invites.some((i) => i.owner === u.id && i.active)) await A.data.createInvite(u.id, name);
    if (role !== 'admin') await Promise.all(A.invites.filter((i) => i.owner === u.id && i.active).map((i) => A.data.setInvite(i.id, { active: false })));
    toast(role === 'admin' ? `${name} מונה למנהל ✓` : `${name} הוא עכשיו משתמש רגיל`);
  } catch (e) { toast(explainError(e), { err: true, ms: 8000 }); }
}

// ------------------------------------------------------------------ stats
const statCache = new Map();
function docStats(uid, doc) {
  if (doc.stats) return Promise.resolve(doc.stats);
  // Older days (before the apps started writing stats): count from the deliveries themselves.
  const ck = `${A.app.root}|${uid}|${doc.key}|${doc.updatedAt || ''}`;
  if (!statCache.has(ck)) statCache.set(ck, A.data.getDeliveries(A.app.root, uid, doc.key).then(statsOf));
  return statCache.get(ck);
}

function sumStats(list) {
  const s = { total: 0, delivered: 0, noAnswer: 0, temp: 0, pending: 0, moved: 0, firstDoneAt: null, lastDoneAt: null };
  for (const x of list) {
    for (const k of ['total', 'delivered', 'noAnswer', 'temp', 'pending', 'moved']) s[k] += x[k] || 0;
    if (x.firstDoneAt && (!s.firstDoneAt || x.firstDoneAt < s.firstDoneAt)) s.firstDoneAt = x.firstDoneAt;
    if (x.lastDoneAt && (!s.lastDoneAt || x.lastDoneAt > s.lastDoneAt)) s.lastDoneAt = x.lastDoneAt;
  }
  return s;
}

// Per-date stats (all versions of a date summed) for one user.
async function userPeriod(uid, from, to) {
  const docs = await A.data.daysInRange(A.app.root, uid, from, to);
  const stats = await Promise.all(docs.map((d) => docStats(uid, d)));
  const byDate = {};
  docs.forEach((d, i) => (byDate[d.date] ||= []).push(stats[i]));
  const days = Object.fromEntries(Object.entries(byDate).map(([date, l]) => [date, sumStats(l)]));
  const worked = Object.values(days).filter((s) => s.total > 0);
  return { days, total: sumStats(worked), workDays: worked.length };
}

// ------------------------------------------------------------------ small components
function avatar(u, size = 36) {
  const style = { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' };
  if (u?.photo) return el('img', { class: 'avatar', src: u.photo, alt: '', referrerpolicy: 'no-referrer', style });
  return el('span', { class: 'avatar', style }, initials(u?.name || u?.email));
}

function accessChip(uid) {
  if (!A.members[uid] && roleOf(uid) !== 'super') return el('span', { class: 'chip none', title: 'נכנס לפני שהיו קישורי הזמנה, או לא הצטרף' }, 'לא חבר');
  return isDisabled(uid) ? el('span', { class: 'chip off' }, '⛔ מושבת') : el('span', { class: 'chip on' }, '● פעיל');
}

function roleChip(uid) {
  const r = roleOf(uid);
  return r === 'super' ? el('span', { class: 'chip role super' }, '⭐ מנהל ראשי')
    : r === 'admin' ? el('span', { class: 'chip role admin' }, '👑 מנהל')
      : r === 'user' ? el('span', { class: 'chip role' }, 'משתמש') : null;
}

// Role control: a dropdown for the superadmin, a chip for everyone else.
function roleControl(u) {
  const r = roleOf(u.id);
  if (!isSuper() || r === 'super' || r === 'none') return roleChip(u.id);
  const sel = el('select', { class: 'role-sel', onchange: (e) => { const v = e.target.value; e.target.value = r; changeRole(u, v); } },
    el('option', { value: 'user' }, 'משתמש'), el('option', { value: 'admin' }, '👑 מנהל'));
  sel.value = r;
  return sel;
}

function invitedByText(uid) {
  const m = A.members[uid];
  if (!m) return '—';
  if (m.invitedBy === 'superadmin') return 'מנהל ראשי';
  return m.invitedBy ? nameOf(m.invitedBy) : '—';
}

// Refs of a member with their lead counts.
const refsOf = (uid) => Object.values(A.refs).filter((r) => r.owner === uid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const leadsOf = (uid) => refsOf(uid).reduce((n, r) => n + (r.leads || 0), 0);

function progress(s, { big = false } = {}) {
  const t = s?.total || 0;
  const seg = (cls, n) => (n ? el('span', { class: 'seg ' + cls, style: { width: (n / t) * 100 + '%' }, title: `${n}` }) : null);
  return el('div', { class: 'progress' + (big ? ' big' : '') },
    el('div', { class: 'bar' }, t ? [seg('ok', s.delivered), seg('fail', s.noAnswer), seg('temp', s.temp)] : null),
    el('span', { class: 'pct' }, t ? `${pct(done(s), t)}%` : '—'));
}

function kpi(label, value, { cls = '', sub = null } = {}) {
  return el('div', { class: 'kpi ' + cls }, el('div', { class: 'kpi-label' }, label), el('div', { class: 'kpi-value' }, value), sub ? el('div', { class: 'kpi-sub' }, sub) : null);
}

function periodBar(per, go) {
  const input = el('input', { type: 'date', value: per.d, onchange: (e) => e.target.value && go({ ...per, d: e.target.value }) });
  const inToday = (() => { const { from, to } = periodRange(per); const t = todayStr(); return from <= t && t <= to; })();
  return el('div', { class: 'period' },
    el('div', { class: 'seg-ctl' }, PERIODS.map(([p, label]) => el('button', { type: 'button', class: p === per.p ? 'on' : '', onclick: () => go({ ...per, p }) }, label))),
    el('div', { class: 'period-nav' },
      el('button', { class: 'icon-btn', type: 'button', title: 'הקודם', onclick: () => go(stepPeriod(per, -1)) }, '→'),
      el('div', { class: 'period-label' }, periodLabel(per)),
      el('button', { class: 'icon-btn', type: 'button', title: 'הבא', onclick: () => go(stepPeriod(per, 1)) }, '←')),
    el('div', { class: 'period-tools' },
      el('button', { class: 'btn small', type: 'button', disabled: inToday, onclick: () => go({ ...per, d: todayStr() }) }, 'היום'),
      input));
}

function locationText(loc) {
  if (!loc) return el('span', { class: 'muted' }, 'לא נקלט מיקום');
  return el('span', {}, `${fmtAgo(loc.at)} · ${fmtStamp(loc.at)}`, loc.accuracy ? el('span', { class: 'muted' }, ` (±${loc.accuracy} מ׳)`) : null, ' ',
    el('a', { href: `https://www.google.com/maps?q=${loc.lat},${loc.lng}`, target: '_blank', rel: 'noopener' }, 'פתח במפה ↗'));
}

// ------------------------------------------------------------------ maps
function newMap(node, center = [32.015, 34.777], zoom = 13) {
  if (!window.L) { node.replaceChildren(el('p', { class: 'muted' }, 'המפה לא נטענה')); return null; }
  // Wheel zoom only after clicking the map, so scrolling the page doesn't zoom it.
  const map = L.map(node, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView(center, zoom);
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  A.view.maps.push(map);
  setTimeout(() => map.invalidateSize(), 60);
  return map;
}

const meIcon = () => L.divIcon({ className: '', html: '<div class="me-marker"></div>', iconSize: [20, 20], iconAnchor: [10, 10] });

// ------------------------------------------------------------------ router
function parseRoute() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const q = new URLSearchParams(qs || '');
  const per = { p: ['day', 'week', 'month'].includes(q.get('p')) ? q.get('p') : 'day', d: /^\d{4}-\d{2}-\d{2}$/.test(q.get('d') || '') ? q.get('d') : todayStr() };
  const [name, arg] = (path || 'overview').split('/');
  return { name: ['overview', 'users', 'user', 'links', 'registrations'].includes(name) ? name : 'overview', arg: arg ? decodeURIComponent(arg) : null, per };
}
const href = (name, arg, per) => `#/${name}${arg ? '/' + encodeURIComponent(arg) : ''}${per ? `?p=${per.p}&d=${per.d}` : ''}`;
const navigate = (name, arg, per) => { location.hash = href(name, arg, per); };

function clearView() {
  const v = A.view;
  v.unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  v.maps.forEach((m) => m.remove());
  clearInterval(v.timer);
  A.view = { id: v.id + 1, unsubs: [], maps: [], timer: null, onUsers: null, onData: null };
  return A.view.id;
}

function route() {
  if (!A.me || !A.role) return;
  const r = parseRoute();
  const id = clearView();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (r.name === 'user' ? 'users' : r.name)));
  const main = $('#main');
  main.replaceChildren();
  window.scrollTo(0, 0);
  if (r.name === 'users') viewUsers(main, id);
  else if (r.name === 'user' && r.arg) viewUser(main, id, r.arg, r.per);
  else if (r.name === 'links') viewLinks(main, id);
  else if (r.name === 'registrations') viewRegistrations(main, id);
  else viewOverview(main, id, r.per);
}

// Today's view refreshes itself every minute (the apps write stats as the courier works).
function autoRefresh(per, fn) {
  const { from, to } = periodRange(per);
  const t = todayStr();
  if (from <= t && t <= to) A.view.timer = setInterval(fn, 60000);
}

// ------------------------------------------------------------------ overview
function viewOverview(main, id, per) {
  const go = (p) => navigate('overview', null, p);
  const kpis = el('div', { class: 'kpis' });
  const table = el('div', { class: 'card' }, el('p', { class: 'muted pad' }, 'טוען…'));
  main.append(el('div', { class: 'view-head' }, el('h1', {}, 'סקירה'), periodBar(per, go)), kpis, table);
  const { from, to } = periodRange(per);

  const load = async () => {
    const users = A.users.slice();
    const res = await Promise.all(users.map((u) => userPeriod(u.id, from, to).catch((e) => ({ error: e }))));
    if (id !== A.view.id) return;
    const err = res.find((r) => r.error);
    if (err && res.every((r) => r.error)) { table.replaceChildren(el('p', { class: 'error pad' }, explainError(err.error))); return; }
    const rows = users.map((u, i) => ({ u, r: res[i] })).filter(({ r }) => !r.error);
    const tot = sumStats(rows.map(({ r }) => r.total));
    const working = rows.filter(({ r }) => r.total.total > 0);

    kpis.replaceChildren(
      kpi(per.p === 'day' ? 'עובדים ביום הזה' : 'עבדו בתקופה', `${working.length}`, { sub: `מתוך ${users.length} משתמשים` }),
      kpi('משלוחים', tot.total),
      kpi('נמסרו', tot.delivered, { cls: 'ok' }),
      kpi('לא ענה – סופי', tot.noAnswer, { cls: 'fail' }),
      kpi(per.p === 'day' ? 'נשארו' : 'לא הושלמו', left(tot), { cls: 'temp' }),
      kpi('הושלם', tot.total ? pct(done(tot), tot.total) + '%' : '—', { sub: progress(tot) }),
    );

    rows.sort((a, b) => b.r.total.total - a.r.total.total || String(a.u.name).localeCompare(String(b.u.name), 'he'));
    const tbody = el('tbody', {}, rows.map(({ u, r }) => {
      const s = r.total;
      return el('tr', { class: 'click' + (s.total ? '' : ' idle'), onclick: () => navigate('user', u.id, per) },
        el('td', {}, el('div', { class: 'who' }, avatar(u), el('div', {}, el('b', {}, u.name || '—'), el('div', { class: 'muted small' }, u.email || u.id)))),
        el('td', {}, accessChip(u.id)),
        per.p !== 'day' ? el('td', { class: 'num' }, r.workDays || '—') : null,
        el('td', { class: 'num' }, s.total || '—'),
        el('td', { class: 'num ok' }, s.delivered || '—'),
        el('td', { class: 'num fail' }, s.noAnswer || '—'),
        el('td', { class: 'num temp' }, left(s) || '—'),
        el('td', { class: 'w-progress' }, progress(s)),
        el('td', { class: 'small' }, per.p === 'day'
          ? (s.firstDoneAt ? `${fmtTime(s.firstDoneAt)} – ${fmtTime(s.lastDoneAt)}` : '—')
          : `נראה ${fmtAgo(u.lastSeen)}`),
      );
    }));
    table.replaceChildren(rows.length
      ? el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'משתמש'), el('th', {}, 'מצב'), per.p !== 'day' ? el('th', { class: 'num' }, 'ימי עבודה') : null,
          el('th', { class: 'num' }, 'משלוחים'), el('th', { class: 'num' }, 'נמסרו'), el('th', { class: 'num' }, 'לא ענה'),
          el('th', { class: 'num' }, per.p === 'day' ? 'נשארו' : 'לא הושלמו'), el('th', {}, 'התקדמות'),
          el('th', {}, per.p === 'day' ? 'משלוח ראשון – אחרון' : 'פעילות'))),
        tbody))
      : el('p', { class: 'muted pad' }, A.usersLoaded ? 'אין עדיין משתמשים. משתמש מופיע כאן אחרי שהוא נכנס לאפליקציה (בגרסה המעודכנת).' : 'טוען…'));
  };
  load();
  A.view.onUsers = load;
  autoRefresh(per, load);
}

// ------------------------------------------------------------------ users
function viewUsers(main, id) {
  const f = A.usersFilter;
  const search = el('input', { type: 'search', placeholder: 'חיפוש לפי שם / אימייל', value: f.q });
  const seg = el('div', { class: 'seg-ctl' });
  const list = el('div', { class: 'card' });
  const today = {}; // uid → today's stats
  main.append(el('div', { class: 'view-head' }, el('h1', {}, 'משתמשים'), el('div', { class: 'filters' }, search, seg)), list);

  const draw = () => {
    if (id !== A.view.id) return;
    const counts = { all: A.users.length, on: A.users.filter((u) => !isDisabled(u.id)).length, off: A.users.filter((u) => isDisabled(u.id)).length };
    seg.replaceChildren(...[['all', 'הכל'], ['on', 'פעילים'], ['off', 'מושבתים']].map(([k, label]) =>
      el('button', { type: 'button', class: f.show === k ? 'on' : '', onclick: () => { f.show = k; draw(); } }, `${label} (${counts[k]})`)));
    const q = f.q.trim().toLowerCase();
    const users = A.users
      .filter((u) => f.show === 'all' || (f.show === 'off') === isDisabled(u.id))
      .filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    if (!users.length) {
      list.replaceChildren(el('p', { class: 'muted pad' }, !A.usersLoaded ? 'טוען…' : A.users.length ? 'אין תוצאות' : 'אין עדיין משתמשים. משתמש מופיע כאן אחרי שהוא נכנס לאפליקציה (בגרסה המעודכנת).'));
      return;
    }
    list.replaceChildren(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, el('th', {}, 'משתמש'), el('th', {}, 'תפקיד'), el('th', {}, 'מצב'), el('th', {}, 'הוזמן ע״י'), el('th', {}, 'היום'),
        el('th', {}, 'נראה לאחרונה'), el('th', {}, 'מיקום אחרון'), el('th', { class: 'num', title: 'נרשמו דרך קישורי ההרשמה שלו' }, 'לידים'), el('th', {}, ''))),
      el('tbody', {}, users.map((u) => {
        const m = A.members[u.id];
        return el('tr', { class: isDisabled(u.id) ? 'disabled' : '' },
          el('td', {}, el('a', { class: 'who', href: href('user', u.id, { p: 'day', d: todayStr() }) }, avatar(u),
            el('div', {}, el('b', {}, u.name || '—'), el('div', { class: 'muted small' }, u.email || u.id)))),
          el('td', {}, roleControl(u)),
          el('td', {}, accessChip(u.id), isDisabled(u.id) && m?.note ? el('div', { class: 'muted small' }, m.note) : null),
          el('td', { class: 'small' }, invitedByText(u.id), m?.joinedAt ? el('div', { class: 'muted small' }, fmtStamp(m.joinedAt).slice(0, 10)) : null),
          el('td', { class: 'w-progress' }, today[u.id] ? (today[u.id].total ? el('div', {}, progress(today[u.id]), el('div', { class: 'muted small' }, `${done(today[u.id])}/${today[u.id].total} בוצעו`)) : el('span', { class: 'muted' }, 'לא עובד')) : el('span', { class: 'muted' }, '…')),
          el('td', { class: 'small', title: fmtStamp(u.lastSeen) }, fmtAgo(u.lastSeen)),
          el('td', { class: 'small' }, u.lastLocation ? el('a', { href: `https://www.google.com/maps?q=${u.lastLocation.lat},${u.lastLocation.lng}`, target: '_blank', rel: 'noopener', title: fmtStamp(u.lastLocation.at) }, `📍 ${fmtAgo(u.lastLocation.at)}`) : el('span', { class: 'muted' }, '—')),
          el('td', { class: 'num' }, leadsOf(u.id) || '—'),
          el('td', { class: 'actions' },
            el('a', { class: 'btn small', href: href('user', u.id, { p: 'day', d: todayStr() }) }, 'פרטים'),
            canToggle(u.id) ? el('button', { class: 'btn small ' + (isDisabled(u.id) ? 'primary' : 'danger-outline'), type: 'button', onclick: () => toggleAccess(u) }, isDisabled(u.id) ? 'הפעל' : 'השבת') : null),
        );
      })))));
  };

  const loadToday = async () => {
    const t = todayStr();
    await Promise.all(A.users.map(async (u) => { try { today[u.id] = (await userPeriod(u.id, t, t)).total; } catch { today[u.id] = { total: 0 }; } }));
    draw();
  };
  search.addEventListener('input', () => { f.q = search.value; draw(); });
  draw();
  loadToday();
  A.view.onUsers = () => { draw(); loadToday(); };
  A.view.timer = setInterval(loadToday, 60000);
}

// ------------------------------------------------------------------ referral codes (refs) of a user
const REF_KIND = { email: 'לפי אימייל', name: 'לפי שם', custom: 'מותאם' };
const regsByRef = () => {
  const out = {};
  for (const r of A.regs) {
    const k = String(r.ref || '').trim().toLowerCase();
    if (!k) continue;
    (out[k] ||= { leads: 0, joined: 0 }).leads++;
    if (r.status === 'joined') out[k].joined++;
  }
  return out;
};

function refsPanel(u) {
  const refs = refsOf(u.id);
  const counts = regsByRef();
  const primary = A.members[u.id]?.primaryRef;
  const box = el('div', { class: 'refs-panel' }, el('h3', {}, '🔗 קישורי הרשמה (Ref)'));
  if (!refs.length) box.append(el('p', { class: 'muted small' }, 'עדיין לא נוצרו קישורי הרשמה. המשתמש יוצר אותם באפליקציה: ☰ ← הזמן חבר.'));
  else {
    box.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl compact' },
      el('thead', {}, el('tr', {}, ['Ref', 'סוג', 'מצב', 'לידים', 'הצטרפו', ''].map((h, i) => el('th', { class: i === 3 || i === 4 ? 'num' : '' }, h)))),
      el('tbody', {}, refs.map((r) => el('tr', { class: r.active === false ? 'idle' : '' },
        el('td', {}, el('b', { class: 'mono' }, r.id), r.id === primary ? el('span', { class: 'chip role admin', title: 'הקישור הראשי שהמשתמש בחר' }, '⭐ ראשי') : null),
        el('td', { class: 'small' }, r.label ? `${REF_KIND[r.kind] || r.kind} · ${r.label}` : REF_KIND[r.kind] || r.kind),
        el('td', {}, r.active === false ? el('span', { class: 'chip off' }, 'כבוי') : el('span', { class: 'chip on' }, 'פעיל')),
        el('td', { class: 'num' }, counts[r.id]?.leads || 0),
        el('td', { class: 'num ok' }, counts[r.id]?.joined || 0),
        el('td', { class: 'actions' },
          el('button', { class: 'btn small', type: 'button', onclick: () => copyText(registrationLink(r.id), 'קישור ההרשמה הועתק ✓') }, '📋 קישור'),
          isSuper() ? el('button', { class: 'btn small', type: 'button', onclick: async () => {
            try { await A.data.updateRef(r.id, { active: r.active === false }); } catch (e) { toast(explainError(e), { err: true }); }
          } }, r.active === false ? 'הפעל' : 'כבה') : null)))))));
  }
  // Superadmin: custom refs for A/B tests ("gil-fb-a", "gil-fb-b" …).
  if (isSuper() && A.members[u.id]) {
    const idIn = el('input', { dir: 'ltr', placeholder: 'gil-fb-a', maxlength: 40, autocomplete: 'off' });
    const labelIn = el('input', { placeholder: 'תיאור, למשל: פייסבוק A', maxlength: 60 });
    idIn.addEventListener('input', () => { idIn.value = idIn.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''); });
    const add = el('button', { class: 'btn small primary', type: 'button' }, '➕ הוסף Ref מותאם');
    add.addEventListener('click', async () => {
      const refId = idIn.value.trim();
      if (!/^[a-z0-9._-]{3,40}$/.test(refId)) return toast('Ref: 3–40 תווים – אותיות באנגלית, ספרות, נקודה, מקף', { err: true });
      add.disabled = true;
      try { await A.data.createRef(refId, { owner: u.id, kind: 'custom', label: labelIn.value.trim() }); toast(`נוסף ${refId} ✓`); idIn.value = ''; labelIn.value = ''; }
      catch (e) { toast(e.code === 'ref-taken' ? `ה-Ref "${refId}" כבר תפוס` : explainError(e), { err: true, ms: 6000 }); }
      add.disabled = false;
    });
    box.append(el('div', { class: 'ref-add' }, idIn, labelIn, add));
  }
  return box;
}

// ------------------------------------------------------------------ magic links (invites)
const myInvite = () => A.invites.find((i) => i.owner === A.me.uid && i.active);
const joinsOf = (token) => Object.values(A.members).filter((m) => m.inviteToken === token).length;
let creatingInvite = null;
async function ensureMyInvite() {
  if (myInvite()) return myInvite();
  if (!A.invitesLoaded) return null;
  creatingInvite ||= A.data.createInvite(A.me.uid, A.me.name || A.me.email).finally(() => { creatingInvite = null; });
  const token = await creatingInvite;
  return A.invites.find((i) => i.id === token) || { id: token, owner: A.me.uid, active: true };
}

async function regenerateInvite(inv) {
  const ok = await dialog({ title: 'ליצור קישור חדש?', body: 'הקישור הנוכחי יפסיק לעבוד מיד. מי שכבר הצטרף דרכו נשאר משתמש.', okText: '🔄 צור קישור חדש', danger: true });
  if (!ok) return;
  try {
    await A.data.setInvite(inv.id, { active: false, deactivatedAt: Date.now() });
    await A.data.createInvite(inv.owner, inv.ownerName || nameOf(inv.owner));
    toast('נוצר קישור חדש ✓');
  } catch (e) { toast(explainError(e), { err: true, ms: 8000 }); }
}

function viewLinks(main, id) {
  const mine = el('div', { class: 'card' });
  const all = el('div', { class: 'card' });
  main.append(el('div', { class: 'view-head' }, el('h1', {}, '🔗 קישורי הצטרפות (Magic Link)')),
    el('p', { class: 'muted' }, 'רק מי שמקבל קישור כזה יכול להירשם ל-SmartRoute. כל מי שיש לו את הקישור יכול להירשם, והמשתמש החדש נרשם על שם בעל הקישור.'),
    mine);
  if (isSuper()) main.append(all);

  const draw = async () => {
    if (id !== A.view.id) return;
    if (!A.invitesLoaded || !A.membersLoaded) { mine.replaceChildren(el('p', { class: 'muted pad' }, 'טוען…')); return; }
    let inv = myInvite();
    if (!inv) {
      mine.replaceChildren(el('p', { class: 'muted pad' }, 'יוצר את הקישור שלך…'));
      try { inv = await ensureMyInvite(); } catch (e) { mine.replaceChildren(el('p', { class: 'error pad' }, explainError(e))); return; }
      if (id !== A.view.id || !inv) return;
    }
    const url = magicLink(inv.id);
    const old = A.invites.filter((i) => i.owner === A.me.uid && !i.active);
    mine.replaceChildren(
      el('h3', {}, 'הקישור שלי'),
      el('div', { class: 'link-box' },
        el('div', { class: 'link-url mono' }, url),
        el('div', { class: 'link-actions' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => copyText(url, 'הקישור הועתק ✓') }, '📋 העתק'),
          el('a', { class: 'btn', href: waLink('', inviteText(url)), target: '_blank', rel: 'noopener' }, '💬 שלח בוואטסאפ'),
          el('button', { class: 'btn danger-outline', type: 'button', onclick: () => regenerateInvite(inv) }, '🔄 קישור חדש')),
        el('div', { class: 'muted small' }, `${joinsOf(inv.id)} הצטרפו דרך הקישור הזה · נוצר ${fmtStamp(inv.createdAt).slice(0, 10)}`),
        old.length ? el('div', { class: 'muted small' }, `קישורים ישנים (כבויים): ${old.map((o) => `${o.id.slice(0, 6)}… (${joinsOf(o.id)} הצטרפו)`).join(' · ')}`) : null),
    );

    if (!isSuper()) return;
    // Superadmin: every link of every admin.
    const admins = A.users.filter((u) => ['admin', 'super'].includes(roleOf(u.id)));
    const withoutLink = admins.filter((u) => !A.invites.some((i) => i.owner === u.id && i.active));
    const rows = A.invites.slice().sort((a, b) => (b.active === true) - (a.active === true) || (b.createdAt || 0) - (a.createdAt || 0));
    all.replaceChildren(
      el('h3', {}, 'כל הקישורים (מנהל ראשי בלבד)'),
      el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, ['בעלים', 'קישור', 'נוצר', 'מצב', 'הצטרפו', ''].map((h, i) => el('th', { class: i === 4 ? 'num' : '' }, h)))),
        el('tbody', {}, rows.map((i) => el('tr', { class: i.active ? '' : 'idle' },
          el('td', {}, el('a', { href: href('user', i.owner, { p: 'day', d: todayStr() }) }, nameOf(i.owner)), ' ', roleChip(i.owner)),
          el('td', { class: 'mono small' }, i.id.slice(0, 8) + '…'),
          el('td', { class: 'small' }, fmtStamp(i.createdAt).slice(0, 10)),
          el('td', {}, i.active ? el('span', { class: 'chip on' }, 'פעיל') : el('span', { class: 'chip off' }, 'כבוי')),
          el('td', { class: 'num' }, joinsOf(i.id)),
          el('td', { class: 'actions' },
            el('button', { class: 'btn small', type: 'button', onclick: () => copyText(magicLink(i.id), 'הקישור הועתק ✓') }, '📋 העתק'),
            el('button', { class: 'btn small', type: 'button', onclick: async () => {
              try { await A.data.setInvite(i.id, { active: !i.active }); } catch (e) { toast(explainError(e), { err: true }); }
            } }, i.active ? 'כבה' : 'הפעל'))))))),
      withoutLink.length ? el('div', { class: 'pad' }, el('span', { class: 'muted small' }, 'מנהלים בלי קישור פעיל: '),
        withoutLink.map((u) => el('button', { class: 'btn small', type: 'button', onclick: async () => {
          try { await A.data.createInvite(u.id, u.name || u.email); toast(`נוצר קישור ל${u.name || u.email} ✓`); } catch (e) { toast(explainError(e), { err: true }); }
        } }, `➕ צור ל${u.name || u.email}`))) : null,
    );
  };
  draw();
  A.view.onData = draw;
  A.view.onUsers = draw;
}

// ------------------------------------------------------------------ registrations
const REG_STATUS = {
  new: { label: 'חדש', cls: 'new' },
  contacted: { label: 'נוצר קשר', cls: 'contacted' },
  joined: { label: 'הצטרף', cls: 'joined' },
  rejected: { label: 'לא רלוונטי', cls: 'rejected' },
};
const REG_FILTERS = [['open', 'פתוחים', (r) => r.status === 'new' || r.status === 'contacted'], ['new', 'חדשים', (r) => r.status === 'new'],
  ['joined', 'הצטרפו', (r) => r.status === 'joined'], ['rejected', 'לא רלוונטי', (r) => r.status === 'rejected'], ['all', 'הכל', () => true]];

async function setRegStatus(r, status, extra = {}) {
  try { await A.data.updateRegistration(r.id, { status, handledBy: A.me.email || '', handledAt: Date.now(), ...extra }); }
  catch (e) { toast(explainError(e), { err: true, ms: 8000 }); }
}

function viewRegistrations(main, id) {
  const f = A.regsFilter;
  const search = el('input', { type: 'search', placeholder: 'חיפוש: שם / טלפון / Ref', value: f.q });
  const seg = el('div', { class: 'seg-ctl' });
  const list = el('div', { class: 'card' });
  main.append(el('div', { class: 'view-head' }, el('h1', {}, '📝 הרשמות'), el('div', { class: 'filters' }, search, seg)),
    el('p', { class: 'muted' }, 'פניות מטופס ההרשמה באתר SmartRoute. מדברים עם הפונה ושולחים לו את קישור ההצטרפות (Magic Link) שלך.'),
    list);

  const refCell = (r) => {
    if (!r.ref) return el('span', { class: 'muted' }, '—');
    const ref = refOf(r.ref);
    return el('div', {}, el('span', { class: 'mono' }, r.ref),
      el('div', { class: 'small' + (ref ? '' : ' muted') }, ref ? `${nameOf(ref.owner)}${ref.label ? ' · ' + ref.label : ''}` : 'Ref לא מוכר'));
  };

  const draw = () => {
    if (id !== A.view.id) return;
    seg.replaceChildren(...REG_FILTERS.map(([k, label, fn]) =>
      el('button', { type: 'button', class: f.status === k ? 'on' : '', onclick: () => { f.status = k; draw(); } }, `${label} (${A.regs.filter(fn).length})`)));
    if (!A.regsLoaded) { list.replaceChildren(el('p', { class: 'muted pad' }, 'טוען…')); return; }
    const fn = REG_FILTERS.find(([k]) => k === f.status)?.[2] || (() => true);
    const q = f.q.trim().toLowerCase();
    const rows = A.regs.filter(fn).filter((r) => !q || `${r.name} ${r.mobile} ${r.ref}`.toLowerCase().includes(q));
    if (!rows.length) { list.replaceChildren(el('p', { class: 'muted pad' }, A.regs.length ? 'אין פניות בסינון הזה.' : 'אין עדיין פניות. קישור הטופס: ' + APP.url + 'Registration')); return; }
    list.replaceChildren(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ['מתי', 'שם', 'טלפון', 'Ref / הופנה ע״י', 'מקור', 'סטטוס', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => {
        const st = REG_STATUS[r.status] || REG_STATUS.new;
        const sel = el('select', { class: 'reg-status ' + st.cls, onchange: (e) => setRegStatus(r, e.target.value) },
          Object.entries(REG_STATUS).map(([k, s]) => el('option', { value: k }, s.label)));
        sel.value = r.status in REG_STATUS ? r.status : 'new';
        const send = async () => {
          const inv = await ensureMyInvite().catch((e) => { toast(explainError(e), { err: true }); return null; });
          if (!inv) return;
          window.open(waLink(r.mobile, inviteText(magicLink(inv.id), r.name.split(' ')[0])), '_blank', 'noopener');
          if (r.status === 'new') setRegStatus(r, 'contacted');
        };
        return el('tr', { class: 'reg-row ' + st.cls },
          el('td', { class: 'small', title: fmtStamp(r.createdAt) }, fmtAgo(r.createdAt), el('div', { class: 'muted' }, fmtStamp(r.createdAt).slice(0, 10))),
          el('td', {}, el('b', {}, r.name), r.note ? el('div', { class: 'muted small' }, '📝 ' + r.note) : null),
          el('td', {}, el('a', { class: 'mono', href: 'tel:' + r.mobile }, r.mobile)),
          el('td', {}, refCell(r)),
          el('td', { class: 'small' }, r.source === 'link' ? 'קישור' : 'ידני'),
          el('td', {}, sel, r.handledBy ? el('div', { class: 'muted small' }, `${r.handledBy.split('@')[0]} · ${fmtAgo(r.handledAt)}`) : null),
          el('td', { class: 'actions' },
            el('button', { class: 'btn small primary', type: 'button', title: 'פותח וואטסאפ עם הודעה וקישור ההצטרפות שלך', onclick: send }, '💬 שלח קישור'),
            el('button', { class: 'btn small', type: 'button', onclick: async () => {
              const inv = await ensureMyInvite().catch(() => null);
              if (inv) copyText(magicLink(inv.id), 'קישור ההצטרפות שלך הועתק ✓');
            } }, '📋'),
            el('button', { class: 'btn small', type: 'button', title: 'הערה', onclick: async () => {
              const ok = await dialog({ title: `הערה – ${r.name}`, okText: 'שמור', note: 'למשל: יחזור אליי ביום ראשון', value: r.note || '' });
              if (ok) try { await A.data.updateRegistration(r.id, { note: ok.note }); } catch (e) { toast(explainError(e), { err: true }); }
            } }, '📝')));
      })))));
  };
  search.addEventListener('input', () => { f.q = search.value; draw(); });
  draw();
  A.view.onData = draw;
  A.view.onUsers = draw;
}

// ------------------------------------------------------------------ user detail
function viewUser(main, id, uid, per) {
  const go = (p) => navigate('user', uid, p);
  const head = el('div', { class: 'card profile' });
  const body = el('div', {});
  main.append(
    el('div', { class: 'crumbs' }, el('a', { href: '#/users' }, '→ כל המשתמשים')),
    head,
    el('div', { class: 'view-head' }, el('h2', {}, per.p === 'day' ? 'יום עבודה' : 'סיכום תקופה'), periodBar(per, go)),
    body);

  const drawHead = () => {
    const u = userById(uid);
    if (!u) { head.replaceChildren(el('p', { class: 'muted pad' }, A.usersLoaded ? 'המשתמש לא נמצא באפליקציה הזו.' : 'טוען…')); return; }
    const m = A.members[uid];
    const invited = Object.values(A.members).filter((x) => x.invitedBy === uid);
    head.replaceChildren(
      el('div', { class: 'profile-main' }, avatar(u, 64),
        el('div', { class: 'profile-id' },
          el('h1', {}, u.name || '—', ' ', accessChip(uid), ' ', roleChip(uid)),
          el('div', {}, u.email || ''),
          el('div', { class: 'muted small mono' }, uid))),
      el('dl', { class: 'facts' },
        el('dt', {}, 'תפקיד'), el('dd', {}, roleControl(u)),
        el('dt', {}, 'הוזמן ע״י'), el('dd', {}, invitedByText(uid), m?.joinedAt ? ` · הצטרף ${fmtStamp(m.joinedAt).slice(0, 10)}` : ''),
        el('dt', {}, 'נראה לאחרונה'), el('dd', { title: fmtStamp(u.lastSeen) }, fmtAgo(u.lastSeen)),
        el('dt', {}, 'מיקום אחרון'), el('dd', {}, locationText(u.lastLocation)),
        el('dt', {}, 'הזמין'), el('dd', {}, invited.length
          ? invited.flatMap((x, i) => [i ? ', ' : '', el('a', { href: href('user', x.id, { p: 'day', d: todayStr() }) }, x.name || x.email || x.id)])
          : el('span', { class: 'muted' }, 'אף אחד עדיין')),
        isDisabled(uid) ? [el('dt', {}, 'הושבת'), el('dd', {}, `${fmtStamp(m.updatedAt)}${m.note ? ' · ' + m.note : ''}`)] : null),
      el('div', { class: 'profile-actions' },
        canToggle(uid) ? el('button', { class: 'btn ' + (isDisabled(uid) ? 'primary' : 'danger-outline'), type: 'button', onclick: () => toggleAccess(u) }, isDisabled(uid) ? '✓ הפעל משתמש' : '⛔ השבת משתמש') : null),
      refsPanel(u),
    );
  };
  drawHead();

  if (per.p === 'day') userDay(body, id, uid, per.d, drawHead);
  else userRange(body, id, uid, per, drawHead);
}

// One date, live: every version of the date and their deliveries.
function userDay(body, id, uid, date, drawHead) {
  const kpis = el('div', { class: 'kpis' });
  const mapNode = el('div', { class: 'map' });
  const legend = el('div', { class: 'legend' },
    [['ok', 'נמסר'], ['fail', 'לא ענה – סופי'], ['temp', 'לא ענה – זמני'], ['pending', 'ממתין'], ['me', 'מיקום אחרון'], ['trail', 'מסלול בפועל']]
      .map(([k, l]) => el('span', {}, el('i', { class: 'dot ' + k }), l)));
  const lists = el('div', { class: 'cols' });
  const versionsNote = el('div', { class: 'muted small' });
  body.append(kpis, el('div', { class: 'card' }, mapNode, legend), versionsNote, lists);
  const map = newMap(mapNode);
  const layers = map ? { route: L.layerGroup().addTo(map), trail: L.layerGroup().addTo(map), stops: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) } : null;
  let days = [], byKey = {}, fitted = false, delUnsubs = {};

  const draw = () => {
    if (id !== A.view.id) return;
    const u = userById(uid);
    const all = days.flatMap((d) => (byKey[d.key] || []).map((x) => ({ ...x, _ver: d.version || 1 })));
    const s = statsOf(all);
    const manyVer = days.length > 1;
    const routeKm = days.map((d) => d.smartDistance ?? d.routeDistance).filter(Boolean).reduce((a, b) => a + b, 0);
    kpis.replaceChildren(
      kpi('משלוחים', s.total, { sub: s.moved ? `${s.moved} הועברו ליום אחר` : null }),
      kpi('נמסרו', s.delivered, { cls: 'ok' }),
      kpi('לא ענה – סופי', s.noAnswer, { cls: 'fail' }),
      kpi('נשארו', left(s), { cls: 'temp', sub: s.temp ? `${s.temp} לא ענה – זמני` : null }),
      kpi('הושלם', s.total ? pct(done(s), s.total) + '%' : '—', { sub: progress(s) }),
      kpi('משך עבודה', s.firstDoneAt ? fmtDuration(s.lastDoneAt - s.firstDoneAt) : '—', { sub: s.firstDoneAt ? `${fmtTime(s.firstDoneAt)} – ${fmtTime(s.lastDoneAt)}${routeKm ? ` · מסלול ${(routeKm / 1000).toFixed(1)} ק״מ` : ''}` : null }),
    );
    versionsNote.textContent = manyVer ? `ביום הזה ${days.length} גרסאות עבודה (${days.map((d) => 'גרסה ' + (d.version || 1)).join(', ')}) – מוצגות יחד.` : '';

    // Lists: what's finished (chronological) and what's left (route order).
    const stopOf = (d) => {
      const st = d.smartUpdatedStop ?? d.updatedStop, sub = d.smartUpdatedStop != null ? d.smartUpdatedSub : d.updatedSub;
      return st == null ? null : sub ? `${st}-${sub}` : `${st}`;
    };
    const fin = all.filter((d) => !d.movedTo && STATUS[d.status]?.final).sort((a, b) => (a.statusAt || 0) - (b.statusAt || 0));
    const rest = all.filter((d) => !d.movedTo && !STATUS[d.status]?.final).sort((a, b) =>
      ((a.smartUpdatedStop ?? a.updatedStop ?? 1e9) - (b.smartUpdatedStop ?? b.updatedStop ?? 1e9)) || ((a.appOrder ?? 1e9) - (b.appOrder ?? 1e9)));
    const moved = all.filter((d) => d.movedTo);
    const row = (d, finished) => {
      const st = STATUS[d.status] || STATUS.pending;
      const tries = (d.history || []).filter((h) => h.status === 'no_answer_temp').length;
      return el('li', { class: 'dl ' + st.cls },
        el('span', { class: 'dl-num' }, finished ? fmtTime(d.statusAt) : (stopOf(d) ?? (d.appOrder != null ? '#' + d.appOrder : '—'))),
        el('div', { class: 'dl-body' },
          el('div', {}, el('b', {}, d.name || d.shipmentId), manyVer ? el('span', { class: 'muted small' }, ` · גרסה ${d._ver}`) : null),
          el('div', { class: 'muted small' }, fmtAddress(d), ` · ${d.shipmentId}`),
          el('div', { class: 'small' }, `${st.icon} ${st.label}`, tries && d.status !== 'no_answer_temp' ? ` · ${tries} ניסיונות קודמים` : tries > 1 ? ` · ${tries} ניסיונות` : '')),
        el('button', { class: 'icon-btn small', type: 'button', title: 'הצג במפה', onclick: () => focusOn(d) }, '📍'));
    };
    lists.replaceChildren(
      el('section', { class: 'card' }, el('h3', {}, `✓ בוצעו (${fin.length})`), fin.length ? el('ol', { class: 'dlist' }, fin.map((d) => row(d, true))) : el('p', { class: 'muted pad' }, 'עדיין לא בוצע אף משלוח.')),
      el('section', { class: 'card' }, el('h3', {}, `⏳ נשארו (${rest.length})`), rest.length ? el('ol', { class: 'dlist' }, rest.map((d) => row(d, false))) : el('p', { class: 'muted pad' }, all.length ? 'הכל בוצע 🎉' : 'אין משלוחים ביום הזה.'),
        moved.length ? el('p', { class: 'muted small pad' }, `➡️ ${moved.length} משלוחים הועברו ליום אחר.`) : null),
    );

    if (!layers) return;
    Object.values(layers).forEach((l) => l.clearLayers());
    const bounds = [];
    for (const d of days) {
      const poly = d.smartPolyline || d.routePolyline;
      if (poly) try { L.polyline(decodePolyline(poly), { color: '#64748b', weight: 3, opacity: 0.45 }).addTo(layers.route); } catch { /* ignore */ }
    }
    for (const d of all.filter((x) => x.lat != null && !x.movedTo)) {
      const st = STATUS[d.status] || STATUS.pending;
      const label = st.final ? '' : (stopOf(d) ?? '');
      L.marker([d.lat, d.lng], { icon: L.divIcon({ className: '', html: `<div class="pin ${st.cls}">${esc(label)}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .bindPopup(`<div dir="rtl"><b>${esc(d.name || d.shipmentId)}</b><br>${esc(fmtAddress(d))}<br>${st.icon} ${esc(st.label)}${d.statusAt ? ' · ' + fmtTime(d.statusAt) : ''}</div>`)
        .addTo(layers.stops);
      bounds.push([d.lat, d.lng]);
    }
    // Where each final status was actually set, in time order = the path the courier took.
    const events = all.flatMap((d) => (d.history || []).filter((h) => h.lat != null && STATUS[h.status]?.final && !d.movedTo).map((h) => ({ ...h, d })))
      .sort((a, b) => a.at - b.at);
    if (events.length > 1) L.polyline(events.map((e) => [e.lat, e.lng]), { color: COLORS.me, weight: 3, opacity: 0.8, dashArray: '6 6' }).addTo(layers.trail);
    events.forEach((e) => L.circleMarker([e.lat, e.lng], { radius: 3, color: COLORS.me, weight: 1, fillOpacity: 1 })
      .bindTooltip(`${fmtTime(e.at)} · ${esc(e.d.name || e.d.shipmentId)}`).addTo(layers.trail));
    const loc = u?.lastLocation;
    if (loc) {
      L.marker([loc.lat, loc.lng], { icon: meIcon(), zIndexOffset: 1000 }).bindPopup(`<div dir="rtl"><b>${esc(u.name || '')}</b><br>מיקום אחרון: ${esc(fmtAgo(loc.at))}<br>${esc(fmtStamp(loc.at))}</div>`).addTo(layers.me);
      if (loc.accuracy) L.circle([loc.lat, loc.lng], { radius: loc.accuracy, color: COLORS.me, weight: 1, fillOpacity: 0.08 }).addTo(layers.me);
      if (todayStr(new Date(loc.at)) === date) bounds.push([loc.lat, loc.lng]);
    }
    if (!fitted && (bounds.length || loc)) {
      if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
      else map.setView([loc.lat, loc.lng], 15);
      fitted = true;
    }
  };

  const focusOn = (d) => {
    if (!map || d.lat == null) return toast('למשלוח הזה אין מיקום', { err: true });
    mapNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.setView([d.lat, d.lng], 17);
    layers.stops.eachLayer((m) => { const p = m.getLatLng(); if (p.lat === d.lat && p.lng === d.lng) m.openPopup(); });
  };

  A.view.unsubs.push(A.data.watchDaysInRange(A.app.root, uid, date, date, (list) => {
    days = list.sort((a, b) => (a.version || 1) - (b.version || 1));
    const keys = new Set(days.map((d) => d.key));
    for (const k of Object.keys(delUnsubs)) if (!keys.has(k)) { delUnsubs[k](); delete delUnsubs[k]; delete byKey[k]; }
    for (const k of keys) {
      if (delUnsubs[k]) continue;
      delUnsubs[k] = A.data.watchDeliveries(A.app.root, uid, k, (dl) => { byKey[k] = dl; draw(); }, (e) => toast(explainError(e), { err: true, ms: 8000 }));
    }
    draw();
  }, (e) => { kpis.replaceChildren(el('p', { class: 'error' }, explainError(e))); }));
  A.view.unsubs.push(() => Object.values(delUnsubs).forEach((u) => u()));
  A.view.onUsers = () => { drawHead(); draw(); };
}

// A week or a month: per-day bars + table.
function userRange(body, id, uid, per, drawHead) {
  const { from, to } = periodRange(per);
  const kpis = el('div', { class: 'kpis' });
  const chart = el('div', { class: 'card' }, el('p', { class: 'muted pad' }, 'טוען…'));
  const table = el('div', { class: 'card' });
  const locCard = el('div', { class: 'card' });
  body.append(kpis, chart, table, locCard);

  const load = async () => {
    let r;
    try { r = await userPeriod(uid, from, to); } catch (e) { chart.replaceChildren(el('p', { class: 'error pad' }, explainError(e))); return; }
    if (id !== A.view.id) return;
    const s = r.total;
    kpis.replaceChildren(
      kpi('ימי עבודה', r.workDays),
      kpi('משלוחים', s.total, { sub: r.workDays ? `ממוצע ${Math.round(s.total / r.workDays)} ליום` : null }),
      kpi('נמסרו', s.delivered, { cls: 'ok' }),
      kpi('לא ענה – סופי', s.noAnswer, { cls: 'fail' }),
      kpi('לא הושלמו', left(s), { cls: 'temp', sub: 'נשארו פתוחים בסוף היום' }),
      kpi('הושלם', s.total ? pct(done(s), s.total) + '%' : '—', { sub: progress(s) }),
    );

    const dates = eachDay(from, to);
    const max = Math.max(1, ...dates.map((d) => r.days[d]?.total || 0));
    const t = todayStr();
    chart.replaceChildren(
      el('h3', {}, 'משלוחים לפי יום'),
      el('div', { class: 'bars' + (dates.length > 10 ? ' dense' : '') }, dates.map((d) => {
        const x = r.days[d];
        const h = (n) => ({ height: ((n || 0) / max) * 100 + '%' });
        return el('button', { type: 'button', class: 'bar-col' + (d === t ? ' today' : '') + (d > t ? ' future' : ''), title: x ? `${longDate(d)}: ${x.total} משלוחים, ${x.delivered} נמסרו, ${x.noAnswer} לא ענה, ${left(x)} נשארו` : longDate(d), onclick: () => navigate('user', uid, { p: 'day', d }) },
          el('span', { class: 'bar-val' }, x?.total || ''),
          el('div', { class: 'bar-stack' }, x ? [el('i', { class: 'ok', style: h(x.delivered) }), el('i', { class: 'fail', style: h(x.noAnswer) }), el('i', { class: 'temp', style: h(left(x)) })] : null),
          el('span', { class: 'bar-day' }, dates.length > 10 ? d.slice(8) : `${'אבגדהוש'[parseDate(d).getDay()]}׳ ${shortDate(d)}`));
      })),
      el('div', { class: 'legend' }, [['ok', 'נמסר'], ['fail', 'לא ענה – סופי'], ['temp', 'לא הושלם']].map(([k, l]) => el('span', {}, el('i', { class: 'dot ' + k }), l)), el('span', { class: 'muted' }, 'לחיצה על יום פותחת אותו')),
    );

    const worked = dates.filter((d) => r.days[d]?.total).reverse();
    table.replaceChildren(el('h3', {}, 'ימי עבודה'), worked.length
      ? el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, ['תאריך', 'משלוחים', 'נמסרו', 'לא ענה', 'לא הושלמו', 'התקדמות', 'שעות', 'משך'].map((h, i) => el('th', { class: i && i < 5 ? 'num' : '' }, h)))),
        el('tbody', {}, worked.map((d) => {
          const x = r.days[d];
          return el('tr', { class: 'click', onclick: () => navigate('user', uid, { p: 'day', d }) },
            el('td', {}, `${dayName(d)} ${shortDate(d)}`),
            el('td', { class: 'num' }, x.total), el('td', { class: 'num ok' }, x.delivered), el('td', { class: 'num fail' }, x.noAnswer || '—'), el('td', { class: 'num temp' }, left(x) || '—'),
            el('td', { class: 'w-progress' }, progress(x)),
            el('td', { class: 'small' }, x.firstDoneAt ? `${fmtTime(x.firstDoneAt)} – ${fmtTime(x.lastDoneAt)}` : '—'),
            el('td', { class: 'small' }, fmtDuration(x.lastDoneAt - x.firstDoneAt)));
        }))))
      : el('p', { class: 'muted pad' }, 'אין ימי עבודה בתקופה הזו.'));
  };

  // Last known location on a small map.
  let map = null, marker = null;
  const drawLoc = () => {
    const loc = userById(uid)?.lastLocation;
    if (!loc) { locCard.replaceChildren(el('h3', {}, 'מיקום אחרון'), el('p', { class: 'muted pad' }, 'לא נקלט מיקום.')); map = null; return; }
    if (!map) {
      const node = el('div', { class: 'map small' });
      locCard.replaceChildren(el('h3', {}, 'מיקום אחרון'), el('p', { class: 'pad-x' }, locationText(loc)), node);
      map = newMap(node, [loc.lat, loc.lng], 15);
      if (!map) return;
      marker = L.marker([loc.lat, loc.lng], { icon: meIcon() }).addTo(map);
    } else {
      locCard.querySelector('p').replaceChildren(locationText(loc));
      marker.setLatLng([loc.lat, loc.lng]);
    }
  };
  load();
  drawLoc();
  A.view.onUsers = () => { drawHead(); drawLoc(); };
  autoRefresh(per, load);
}

// ------------------------------------------------------------------ live data & boot
// Users = members (who may use SmartRoute) merged with their app profiles (last seen, location).
function mergeUsers() {
  const map = new Map(A.profiles.map((p) => [p.id, { ...p }]));
  for (const m of Object.values(A.members)) {
    const cur = map.get(m.id) || { id: m.id };
    map.set(m.id, { ...cur, name: cur.name || m.name, email: cur.email || m.email });
  }
  A.users = [...map.values()];
  A.usersLoaded = A.profilesLoaded && A.membersLoaded;
}

// Members see how many leads their refs brought (refs/{ref}.leads) without reading registrations,
// so the panel keeps those counters in sync with the registration list.
let leadsTimer = null;
function syncLeads() {
  clearTimeout(leadsTimer);
  leadsTimer = setTimeout(() => {
    if (!A.regsLoaded) return;
    const counts = regsByRef();
    for (const r of Object.values(A.refs)) {
      const n = counts[r.id.toLowerCase()]?.leads || 0;
      if ((r.leads || 0) !== n) A.data.updateRef(r.id, { leads: n }).catch(() => {});
    }
  }, 1500);
}

function updateBadge() {
  const n = A.regs.filter((r) => r.status === 'new').length;
  $('#regBadge').textContent = n;
  $('#regBadge').hidden = !n;
}

function listenAll() {
  A.listeners.forEach((u) => u());
  Object.assign(A, { users: [], profiles: [], members: {}, invites: [], refs: {}, regs: [], usersLoaded: false, profilesLoaded: false, membersLoaded: false, invitesLoaded: false, regsLoaded: false });
  const onErr = (e) => { $('#main').replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error pad' }, explainError(e)))); };
  const usersChanged = () => { mergeUsers(); A.view.onUsers?.(); };
  A.listeners = [
    A.data.watchUsers(A.app.root, (p) => { A.profiles = p; A.profilesLoaded = true; usersChanged(); }, onErr),
    A.data.watchMembers((list) => {
      A.members = Object.fromEntries(list.map((m) => [m.id, m]));
      A.membersLoaded = true;
      // Lost admin rights while the panel is open (demoted / disabled) → back to the gate.
      const mine = A.members[A.me.uid];
      if (A.role === 'admin' && (mine?.role !== 'admin' || mine?.disabled)) { location.reload(); return; }
      usersChanged();
    }, onErr),
    A.data.watchInvites(isSuper() ? null : A.me.uid, (list) => { A.invites = list; A.invitesLoaded = true; A.view.onData?.(); }, onErr),
    A.data.watchRefs((list) => { A.refs = Object.fromEntries(list.map((r) => [r.id.toLowerCase(), r])); syncLeads(); A.view.onUsers?.(); }, onErr),
    A.data.watchRegistrations((list) => { A.regs = list; A.regsLoaded = true; updateBadge(); syncLeads(); A.view.onData?.(); }, onErr),
  ];
}

function showScreen(name) {
  for (const s of ['loading', 'login', 'denied', 'shell']) $('#' + s).hidden = s !== name;
}

async function boot() {
  try { A.data = await createData(); }
  catch (e) { $('#loading').textContent = 'שגיאה בחיבור ל-Firebase: ' + e.message; return; }
  $('#demoBanner').hidden = A.data.mode !== 'demo';

  const signIn = async () => { $('#loginErr').textContent = ''; try { await A.data.signIn(); } catch (e) { $('#loginErr').textContent = e.message; } };
  $('#loginBtn').addEventListener('click', signIn);
  $('#switchBtn').addEventListener('click', async () => { await A.data.signOut(); signIn(); });
  $('#logoutBtn').addEventListener('click', () => A.data.signOut());
  window.addEventListener('hashchange', route);

  // Only the superadmin and active admins may use the panel. Regular users – never.
  A.data.onAuth(async (user) => {
    A.me = user;
    A.role = null;
    if (!user) { A.listeners.forEach((u) => u()); A.listeners = []; clearView(); showScreen('login'); return; }
    showScreen('loading');
    let role = null;
    if (String(user.email || '').toLowerCase() === SUPERADMIN) role = 'super';
    else {
      const m = await A.data.getMember(user.uid).catch(() => null);
      if (m?.role === 'admin' && !m.disabled) role = 'admin';
    }
    if (A.me !== user) return;
    if (!role) { $('#deniedEmail').textContent = user.email; showScreen('denied'); return; }
    A.role = role;
    $('#meBox').replaceChildren(avatar(user, 28), el('span', { class: 'me-email' }, user.email),
      el('span', { class: 'chip role ' + (role === 'super' ? 'super' : 'admin') }, role === 'super' ? '⭐ מנהל ראשי' : '👑 מנהל'));
    showScreen('shell');
    listenAll();
    route();
  });
}

boot();
