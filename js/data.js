// Data layer for the admin panel. Reads the SmartRoute data (labUsers/{uid}) of every user
// (allowed for admins by firestore.rules) and writes only access/{uid} (enable / disable).
// ?demo=1 → generated sample data in memory, no cloud access.
import { firebaseConfig } from './config.js';
import { todayStr, addDays } from './util.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

// ---------------------------------------------------------------- Firebase
async function firebaseBackend() {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${FB}/firebase-app.js`),
    import(`${FB}/firebase-auth.js`),
    import(`${FB}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebaseConfig, 'smartroute-admin');
  const a = auth.getAuth(app);
  const db = fs.getFirestore(app);
  let me = null;
  const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return {
    mode: 'firebase',
    onAuth(cb) {
      auth.getRedirectResult(a).catch(() => {});
      return auth.onAuthStateChanged(a, (u) => { me = u; cb(u ? { uid: u.uid, name: u.displayName, email: u.email, photo: u.photoURL } : null); });
    },
    async signIn() {
      const provider = new auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await auth.signInWithPopup(a, provider); }
      catch (e) {
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) await auth.signInWithRedirect(a, provider);
        else throw e;
      }
    },
    signOut: () => auth.signOut(a),

    watchUsers: (root, cb, onErr) => fs.onSnapshot(fs.collection(db, root), (s) => cb(list(s)), onErr),
    watchAccess: (cb, onErr) => fs.onSnapshot(fs.collection(db, 'access'), (s) => cb(Object.fromEntries(list(s).map((x) => [x.id, x]))), onErr),
    setAccess: (uid, patch) => fs.setDoc(fs.doc(db, 'access', uid), { ...patch, updatedAt: Date.now(), updatedBy: me?.email || '' }, { merge: true }),

    // Day docs ("2026-09-30", "2026-09-30_v2" …) whose date is within [from, to].
    async daysInRange(root, uid, from, to) {
      const q = fs.query(fs.collection(db, root, uid, 'days'), fs.where('date', '>=', from), fs.where('date', '<=', to));
      return list(await fs.getDocs(q)).map((d) => ({ ...d, key: d.key || d.id }));
    },
    watchDaysInRange(root, uid, from, to, cb, onErr) {
      const q = fs.query(fs.collection(db, root, uid, 'days'), fs.where('date', '>=', from), fs.where('date', '<=', to));
      return fs.onSnapshot(q, (s) => cb(list(s).map((d) => ({ ...d, key: d.key || d.id }))), onErr);
    },
    async getDeliveries(root, uid, key) { return list(await fs.getDocs(fs.collection(db, root, uid, 'days', key, 'deliveries'))); },
    watchDeliveries: (root, uid, key, cb, onErr) => fs.onSnapshot(fs.collection(db, root, uid, 'days', key, 'deliveries'), (s) => cb(list(s)), onErr),
  };
}

// ---------------------------------------------------------------- Demo (sample data, in memory)
function demoBackend() {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const STREETS = ['סוקולוב', 'ההסתדרות', 'שנקר', 'הנוטרים', 'ויצמן', 'קוגל', 'אילת', 'המעפילים', 'גולדה מאיר', 'פילדלפיה', 'השומר', "ז'בוטינסקי", 'הרצל', 'משה שרת'];
  const NAMES = ['אבי', 'רונית', 'משה', 'שרה', 'דוד', 'נועה', 'איתי', 'ליאת', 'Daniel', 'Maria', 'יעקב', 'תמר', 'עומר', 'הילה'];
  const LAST = ['כהן', 'לוי', 'מזרחי', 'פרץ', 'ביטון', 'אזולאי', 'Smith', 'פרידמן', 'שפירא'];
  const today = todayStr();
  const H = 3600000, M = 60000, now = Date.now();
  const at = (date, h, m = 0) => { const [y, mo, d] = date.split('-'); return new Date(+y, +mo - 1, +d, h, m).getTime(); };

  const store = { labUsers: {} };        // root → uid → { profile, days: { key: { doc, deliveries } } }
  const access = { u3: { disabled: true, note: 'עזב את העבודה', updatedAt: now - 5 * 24 * H, updatedBy: 'admin' } };

  function makeDay(date, n, doneRatio, { withStats = true, startH = 8.5 } = {}) {
    const deliveries = [];
    let t = at(date, Math.floor(startH), (startH % 1) * 60);
    const done = Math.round(n * doneRatio);
    for (let i = 0; i < n; i++) {
      const lat = 32.004 + rnd() * 0.026, lng = 34.763 + rnd() * 0.03;
      const d = {
        shipmentId: String(19800000 + Math.floor(rnd() * 99999)), name: `${pick(NAMES)} ${pick(LAST)}`,
        street: pick(STREETS), houseNo: String(1 + Math.floor(rnd() * 90)), city: 'חולון', appOrder: i + 1, ref: rnd() < 0.3 ? String(5000 + i) : null,
        lat, lng, geoStatus: rnd() < 0.85 ? 'ok' : 'approx', status: 'pending', statusAt: null, history: [],
        initialStop: i + 1, initialSub: null, updatedStop: i + 1, updatedSub: null,
      };
      if (i < done) {
        t += (4 + rnd() * 9) * M;
        const r = rnd();
        if (r < 0.08) d.history.push({ status: 'no_answer_temp', at: t - 40 * M, lat: lat + 0.0002, lng });
        d.status = r < 0.06 ? 'no_answer_final' : r < 0.5 ? 'delivered_door' : 'delivered_hand';
        d.statusAt = t;
        d.history.push({ status: d.status, at: t, lat: lat + (rnd() - 0.5) * 0.0004, lng: lng + (rnd() - 0.5) * 0.0004 });
        d.updatedStop = null;
      } else if (rnd() < 0.12) {
        d.status = 'no_answer_temp'; d.statusAt = t; d.history.push({ status: 'no_answer_temp', at: t, lat, lng });
      }
      deliveries.push(d);
    }
    // Remaining deliveries get a fresh "updated" numbering, like the app does after a rebuild.
    deliveries.filter((d) => d.status === 'pending' || d.status === 'no_answer_temp').forEach((d, i) => (d.updatedStop = i + 1));
    const doc = { date, key: date, version: 1, total: n, active: n - done, hasInitialRoute: true, initialBuiltAt: at(date, 8), updatedAt: t };
    if (withStats) Object.assign(doc, { stats: statsOf(deliveries) });
    return { doc, deliveries };
  }

  function addUser(root, uid, profile, { workProb, todayRatio, from = 45 }) {
    const u = (store[root][uid] = { profile: { id: uid, uid, ...profile }, days: {} });
    for (let i = from; i >= 0; i--) {
      const date = addDays(today, -i);
      const dow = new Date(date + 'T12:00').getDay();
      if (dow === 6 || (i > 0 && rnd() > workProb)) continue;
      if (i === 0 && todayRatio == null) continue;
      const n = 22 + Math.floor(rnd() * 22);
      u.days[date] = makeDay(date, n, i === 0 ? todayRatio : 1, { withStats: i < 20 });
    }
    // A second run ("version 2") on one earlier day, with the unfinished ones moved into it.
    const v2 = addDays(today, -2);
    if (u.days[v2]) {
      const extra = makeDay(v2, 6, 1, { startH: 15 });
      extra.doc = { ...extra.doc, key: `${v2}_v2`, version: 2 };
      u.days[`${v2}_v2`] = extra;
    }
  }

  addUser('labUsers', 'u1', { name: 'יוסי כהן', email: 'yossi.courier@example.com', photo: '', app: 'SmartRoute', firstSeen: now - 60 * 24 * H, lastSeen: now - 2 * M,
    lastLocation: { lat: 32.0158, lng: 34.7792, accuracy: 12, at: now - 3 * M } }, { workProb: 0.9, todayRatio: 0.55 });
  addUser('labUsers', 'u2', { name: 'מיכל לוי', email: 'michal.l@example.com', photo: '', app: 'SmartRoute', firstSeen: now - 40 * 24 * H, lastSeen: now - 50 * M,
    lastLocation: { lat: 32.0101, lng: 34.7703, accuracy: 25, at: now - 55 * M } }, { workProb: 0.8, todayRatio: 1 });
  addUser('labUsers', 'u3', { name: 'דני אברהם', email: 'dani.a@example.com', photo: '', app: 'SmartRoute', firstSeen: now - 90 * 24 * H, lastSeen: now - 6 * 24 * H,
    lastLocation: { lat: 32.021, lng: 34.781, accuracy: 30, at: now - 6 * 24 * H } }, { workProb: 0.7, todayRatio: null, from: 45 });
  Object.keys(store.labUsers.u3.days).forEach((k) => { if (k > addDays(today, -6)) delete store.labUsers.u3.days[k]; });
  addUser('labUsers', 'u4', { name: 'Ron Test', email: 'ron.test@example.com', photo: '', app: 'SmartRoute', firstSeen: now - 4 * 24 * H, lastSeen: now - 3 * 24 * H }, { workProb: 0.3, todayRatio: null, from: 4 });
  
  // Watchers + a slow "live" tick: u1 delivers the next parcel every 20 seconds.
  const watchers = new Set();
  const emit = () => watchers.forEach((w) => w());
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const watch = (fn) => { const w = () => fn(); watchers.add(w); setTimeout(w, 0); return () => watchers.delete(w); };
  setInterval(() => {
    const day = store.labUsers.u1.days[today];
    const next = day?.deliveries.filter((d) => d.status === 'pending').sort((a, b) => a.updatedStop - b.updatedStop)[0];
    if (!next) return;
    const t = Date.now();
    next.status = 'delivered_hand'; next.statusAt = t; next.updatedStop = null;
    next.history.push({ status: 'delivered_hand', at: t, lat: next.lat, lng: next.lng });
    day.doc.stats = statsOf(day.deliveries); day.doc.active--; day.doc.updatedAt = t;
    Object.assign(store.labUsers.u1.profile, { lastSeen: t, lastLocation: { lat: next.lat, lng: next.lng, accuracy: 10, at: t } });
    emit();
  }, 20000);

  const days = (root, uid, from, to) => Object.values(store[root][uid]?.days || {}).map((x) => clone(x.doc)).filter((d) => d.date >= from && d.date <= to);
  return {
    mode: 'demo',
    onAuth(cb) { setTimeout(() => cb({ uid: 'admin', name: 'מנהל (הדגמה)', email: 'gbitman.bd@gmail.com' }), 0); return () => {}; },
    signIn: async () => {}, signOut: async () => { location.search = ''; },
    watchUsers: (root, cb) => watch(() => cb(Object.values(store[root]).map((u) => clone(u.profile)))),
    watchAccess: (cb) => watch(() => cb(clone(access))),
    setAccess: async (uid, patch) => { access[uid] = { ...(access[uid] || {}), ...patch, updatedAt: Date.now(), updatedBy: 'admin' }; emit(); },
    daysInRange: async (root, uid, from, to) => days(root, uid, from, to),
    watchDaysInRange: (root, uid, from, to, cb) => watch(() => cb(days(root, uid, from, to))),
    getDeliveries: async (root, uid, key) => clone(store[root][uid]?.days[key]?.deliveries || []),
    watchDeliveries: (root, uid, key, cb) => watch(() => cb(clone(store[root][uid]?.days[key]?.deliveries || []))),
  };
}

// Same numbers the apps write into day.stats (deliveries moved to another day are counted there).
export function statsOf(deliveries) {
  const live = deliveries.filter((d) => !d.movedTo);
  const count = (...st) => live.filter((d) => st.includes(d.status)).length;
  const final = ['delivered_hand', 'delivered_door', 'no_answer_final'];
  const doneAt = live.filter((d) => final.includes(d.status) && d.statusAt).map((d) => d.statusAt);
  const delivered = count('delivered_hand', 'delivered_door'), noAnswer = count('no_answer_final'), temp = count('no_answer_temp');
  return {
    total: live.length, delivered, noAnswer, temp, pending: live.length - delivered - noAnswer - temp,
    moved: deliveries.length - live.length,
    firstDoneAt: doneAt.length ? Math.min(...doneAt) : null, lastDoneAt: doneAt.length ? Math.max(...doneAt) : null,
  };
}

export async function createData() {
  if (new URLSearchParams(location.search).has('demo')) return demoBackend();
  return firebaseBackend();
}
