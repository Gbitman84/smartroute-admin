import { createData, statsOf } from './data.js';
import { ADMIN_EMAILS, APP } from './config.js';
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
  app: APP,
  users: [], access: {}, usersLoaded: false,
  listeners: [],       // app-wide (users + access)
  view: { id: 0, unsubs: [], maps: [], timer: null, onUsers: null },
  usersFilter: { q: '', show: 'all' },
};

const isDisabled = (uid) => A.access[uid]?.disabled === true;
const userById = (uid) => A.users.find((u) => u.id === uid);
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
function dialog({ title, body, okText = 'אישור', danger = false, note = null }) {
  return new Promise((resolve) => {
    const input = note ? el('textarea', { rows: 2, placeholder: note }) : null;
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
    await A.data.setAccess(u.id, {
      disabled: disable, email: u.email || '', name: u.name || '',
      ...(disable ? { note: ok.note, disabledAt: Date.now() } : { note: '', enabledAt: Date.now() }),
    });
    toast(disable ? `${name} הושבת` : `${name} הופעל מחדש ✓`);
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
  return isDisabled(uid) ? el('span', { class: 'chip off' }, '⛔ מושבת') : el('span', { class: 'chip on' }, '● פעיל');
}

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
  return { name: ['overview', 'users', 'user'].includes(name) ? name : 'overview', arg: arg ? decodeURIComponent(arg) : null, per };
}
const href = (name, arg, per) => `#/${name}${arg ? '/' + encodeURIComponent(arg) : ''}${per ? `?p=${per.p}&d=${per.d}` : ''}`;
const navigate = (name, arg, per) => { location.hash = href(name, arg, per); };

function clearView() {
  const v = A.view;
  v.unsubs.forEach((u) => { try { u(); } catch { /* ignore */ } });
  v.maps.forEach((m) => m.remove());
  clearInterval(v.timer);
  A.view = { id: v.id + 1, unsubs: [], maps: [], timer: null, onUsers: null };
  return A.view.id;
}

function route() {
  if (!A.me || !A.isAdmin) return;
  const r = parseRoute();
  const id = clearView();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (r.name === 'user' ? 'users' : r.name)));
  const main = $('#main');
  main.replaceChildren();
  window.scrollTo(0, 0);
  if (r.name === 'users') viewUsers(main, id);
  else if (r.name === 'user' && r.arg) viewUser(main, id, r.arg, r.per);
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
      el('thead', {}, el('tr', {}, el('th', {}, 'משתמש'), el('th', {}, 'מצב'), el('th', {}, 'היום'), el('th', {}, 'נראה לאחרונה'), el('th', {}, 'מיקום אחרון'), el('th', {}, ''))),
      el('tbody', {}, users.map((u) => {
        const acc = A.access[u.id];
        return el('tr', { class: isDisabled(u.id) ? 'disabled' : '' },
          el('td', {}, el('a', { class: 'who', href: href('user', u.id, { p: 'day', d: todayStr() }) }, avatar(u),
            el('div', {}, el('b', {}, u.name || '—'), el('div', { class: 'muted small' }, u.email || u.id)))),
          el('td', {}, accessChip(u.id), isDisabled(u.id) && acc?.note ? el('div', { class: 'muted small' }, acc.note) : null),
          el('td', { class: 'w-progress' }, today[u.id] ? (today[u.id].total ? el('div', {}, progress(today[u.id]), el('div', { class: 'muted small' }, `${done(today[u.id])}/${today[u.id].total} בוצעו`)) : el('span', { class: 'muted' }, 'לא עובד')) : el('span', { class: 'muted' }, '…')),
          el('td', { class: 'small', title: fmtStamp(u.lastSeen) }, fmtAgo(u.lastSeen)),
          el('td', { class: 'small' }, u.lastLocation ? el('a', { href: `https://www.google.com/maps?q=${u.lastLocation.lat},${u.lastLocation.lng}`, target: '_blank', rel: 'noopener', title: fmtStamp(u.lastLocation.at) }, `📍 ${fmtAgo(u.lastLocation.at)}`) : el('span', { class: 'muted' }, '—')),
          el('td', { class: 'actions' },
            el('a', { class: 'btn small', href: href('user', u.id, { p: 'day', d: todayStr() }) }, 'פרטים'),
            el('button', { class: 'btn small ' + (isDisabled(u.id) ? 'primary' : 'danger-outline'), type: 'button', onclick: () => toggleAccess(u) }, isDisabled(u.id) ? 'הפעל' : 'השבת')),
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
    const acc = A.access[uid];
    head.replaceChildren(
      el('div', { class: 'profile-main' }, avatar(u, 64),
        el('div', { class: 'profile-id' },
          el('h1', {}, u.name || '—', ' ', accessChip(uid)),
          el('div', {}, u.email || ''),
          el('div', { class: 'muted small mono' }, uid))),
      el('dl', { class: 'facts' },
        el('dt', {}, 'נראה לאחרונה'), el('dd', { title: fmtStamp(u.lastSeen) }, fmtAgo(u.lastSeen)),
        el('dt', {}, 'משתמש מאז'), el('dd', {}, u.firstSeen ? fmtStamp(u.firstSeen).slice(0, 10) : '—'),
        el('dt', {}, 'מיקום אחרון'), el('dd', {}, locationText(u.lastLocation)),
        isDisabled(uid) ? [el('dt', {}, 'הושבת'), el('dd', {}, `${fmtStamp(acc.disabledAt || acc.updatedAt)}${acc.note ? ' · ' + acc.note : ''}`)] : null),
      el('div', { class: 'profile-actions' },
        el('button', { class: 'btn ' + (isDisabled(uid) ? 'primary' : 'danger-outline'), type: 'button', onclick: () => toggleAccess(u) }, isDisabled(uid) ? '✓ הפעל משתמש' : '⛔ השבת משתמש')),
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

// ------------------------------------------------------------------ boot

function listenUsers() {
  A.listeners.forEach((u) => u());
  A.users = []; A.usersLoaded = false;
  const onErr = (e) => { $('#main').replaceChildren(el('div', { class: 'card' }, el('p', { class: 'error pad' }, explainError(e)))); };
  A.listeners = [
    A.data.watchUsers(A.app.root, (users) => { A.users = users; A.usersLoaded = true; A.view.onUsers?.(); }, onErr),
    A.data.watchAccess((acc) => { A.access = acc; A.view.onUsers?.(); }, onErr),
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

  A.data.onAuth((user) => {
    A.me = user;
    A.isAdmin = !!user && ADMIN_EMAILS.includes(String(user.email).toLowerCase());
    if (!user) { A.listeners.forEach((u) => u()); A.listeners = []; clearView(); showScreen('login'); return; }
    if (!A.isAdmin) { $('#deniedEmail').textContent = user.email; showScreen('denied'); return; }
    $('#meBox').replaceChildren(avatar(user, 28), el('span', { class: 'me-email' }, user.email));
    showScreen('shell');
    listenUsers();
    route();
  });
}

boot();
