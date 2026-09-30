// Data layer for the admin panel. Reads the SmartRoute data (labUsers/{uid}) of every user and
// manages members (roles, enable/disable), magic links (invites), referral codes (refs) and
// registration requests. Every permission is enforced by firestore.rules.
// ?demo=1 → generated sample data in memory, no cloud access (&as=admin → view as a regular admin).
import { firebaseConfig } from './config.js';
import { todayStr, addDays } from './util.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';
const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const newToken = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => TOKEN_CHARS[b % TOKEN_CHARS.length]).join('');
const millis = (v) => (v?.toMillis ? v.toMillis() : v ?? null);

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
  // ?emu=1 → local Firebase emulators (tests only). Never set in real use.
  if (new URLSearchParams(location.search).has('emu')) {
    auth.connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
    fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    // Test hook: sign in a seeded emulator test account (SmartRoute/tests/seed.mjs) without the Google popup.
    window.__emuSignIn = (email, password) => auth.signInWithEmailAndPassword(a, email, password);
  }
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

    // Profiles written by the app (labUsers/{uid}: name, last seen, last location).
    watchUsers: (root, cb, onErr) => fs.onSnapshot(fs.collection(db, root), (s) => cb(list(s)), onErr),

    // Members: role ('user' | 'admin'), disabled, who invited them, refSuffix / primaryRef.
    async getMember(uid) { const s = await fs.getDoc(fs.doc(db, 'members', uid)); return s.exists() ? { id: s.id, ...s.data() } : null; },
    watchMembers: (cb, onErr) => fs.onSnapshot(fs.collection(db, 'members'), (s) => cb(list(s)), onErr),
    setMember: (uid, patch) => fs.updateDoc(fs.doc(db, 'members', uid), { ...patch, updatedAt: Date.now(), updatedBy: me?.email || '' }),

    // Superadmin only: remove a user – membership, refs, magic links off, and (withData) all their work data.
    // Their Google sign-in stays, but without a member doc they get "user doesn't exist".
    async deleteUser(root, uid, { withData = true, onProgress = () => {} } = {}) {
      const refs = [];
      const del = (ref) => refs.push(ref);
      const docsOf = async (...path) => (await fs.getDocs(fs.collection(db, ...path))).docs.map((d) => d.ref);
      (await fs.getDocs(fs.query(fs.collection(db, 'refs'), fs.where('owner', '==', uid)))).docs.forEach((d) => del(d.ref));
      const invites = (await fs.getDocs(fs.query(fs.collection(db, 'invites'), fs.where('owner', '==', uid)))).docs;
      if (withData) {
        onProgress('אוסף נתונים…');
        for (const day of await docsOf(root, uid, 'days')) {
          (await docsOf(root, uid, 'days', day.id, 'deliveries')).forEach(del);
          del(day);
        }
        for (const sub of ['meta', 'geocache', 'imports']) (await docsOf(root, uid, sub)).forEach(del);
        del(fs.doc(db, root, uid));
      }
      del(fs.doc(db, 'members', uid)); // last, so a failure half-way leaves the user visible and retryable
      for (let i = 0; i < refs.length; i += 400) {
        onProgress(`מוחק ${Math.min(i + 400, refs.length)}/${refs.length}…`);
        const b = fs.writeBatch(db);
        refs.slice(i, i + 400).forEach((r) => b.delete(r));
        if (i + 400 >= refs.length) invites.forEach((d) => b.update(d.ref, { active: false, deactivatedAt: Date.now() }));
        await b.commit();
      }
      return refs.length;
    },

    // Magic links: invites/{token}. ownerUid → only that owner's links (regular admins), null → all.
    watchInvites: (ownerUid, cb, onErr) => fs.onSnapshot(
      ownerUid ? fs.query(fs.collection(db, 'invites'), fs.where('owner', '==', ownerUid)) : fs.collection(db, 'invites'),
      (s) => cb(list(s)), onErr),
    async createInvite(owner, ownerName) {
      const token = newToken();
      await fs.setDoc(fs.doc(db, 'invites', token), { owner, ownerName: ownerName || '', active: true, createdAt: Date.now(), createdBy: me?.email || '' });
      return token;
    },
    setInvite: (token, patch) => fs.updateDoc(fs.doc(db, 'invites', token), patch),

    // Referral codes: refs/{ref}. createRef fails if the ref is already taken.
    watchRefs: (cb, onErr) => fs.onSnapshot(fs.collection(db, 'refs'), (s) => cb(list(s)), onErr),
    async createRef(id, data) {
      await fs.runTransaction(db, async (tx) => {
        const ref = fs.doc(db, 'refs', id);
        if ((await tx.get(ref)).exists()) throw Object.assign(new Error('ref taken'), { code: 'ref-taken' });
        tx.set(ref, { ...data, active: true, leads: 0, createdAt: Date.now() });
      });
    },
    updateRef: (id, patch) => fs.updateDoc(fs.doc(db, 'refs', id), patch),

    // Daily limits per role (config/limits, superadmin writes) and today's usage (quota/<kind>-<day>, functions write).
    watchLimits: (cb, onErr) => fs.onSnapshot(fs.doc(db, 'config', 'limits'), (s) => cb(s.exists() ? s.data() : null), onErr),
    setLimits: (data) => fs.setDoc(fs.doc(db, 'config', 'limits'), { ...data, updatedAt: Date.now(), updatedBy: me?.email || '' }),
    async getQuota(docId) { const s = await fs.getDoc(fs.doc(db, 'quota', docId)); return s.exists() ? s.data() : null; },

    // Registration requests from the public form (newest first).
    watchRegistrations: (cb, onErr) => fs.onSnapshot(
      fs.query(fs.collection(db, 'registrations'), fs.orderBy('createdAt', 'desc'), fs.limit(500)),
      (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data(), createdAt: millis(d.data().createdAt) }))), onErr),
    updateRegistration: (id, patch) => fs.updateDoc(fs.doc(db, 'registrations', id), patch),

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
  // Members, magic links, refs and registrations. "sa" is the superadmin; u2 is an admin.
  const as = new URLSearchParams(location.search).get('as'); // admin | user → view as that role
  const meUser = as === 'admin' ? { uid: 'u2', name: 'מיכל לוי', email: 'michal.l@example.com' }
    : as === 'user' ? { uid: 'u1', name: 'יוסי כהן', email: 'yossi.courier@example.com' }
      : { uid: 'sa', name: 'Gil (superadmin)', email: 'gbitman.bd@gmail.com' };
  let authCb = null;
  const mem = (id, o) => ({ id, uid: id, role: 'user', disabled: false, joinedAt: now - 30 * 24 * H, refSuffix: 'x' + id.padEnd(5, '0').slice(0, 5), ...o });
  const members = {
    sa: mem('sa', { name: 'Gil', email: 'gbitman.bd@gmail.com', invitedBy: 'superadmin', refSuffix: 'd87d32', primaryRef: 'gil-d87d32', joinedAt: now - 90 * 24 * H }),
    u2: mem('u2', { name: 'מיכל לוי', email: 'michal.l@example.com', role: 'admin', invitedBy: 'sa', inviteToken: 'SaToken000000000000001', refSuffix: 'm1c4l0', primaryRef: 'michal-m1c4l0' }),
    u1: mem('u1', { name: 'יוסי כהן', email: 'yossi.courier@example.com', invitedBy: 'u2', inviteToken: 'U2Token000000000000001', refSuffix: 'y0551e' }),
    u3: mem('u3', { name: 'דני אברהם', email: 'dani.a@example.com', invitedBy: 'sa', inviteToken: 'SaToken000000000000001', disabled: true, note: 'עזב את העבודה', updatedAt: now - 5 * 24 * H, updatedBy: 'admin' }),
    u4: mem('u4', { name: 'Ron Test', email: 'ron.test@example.com', invitedBy: 'u2', inviteToken: 'U2Token000000000000001', joinedAt: now - 4 * 24 * H }),
  };
  const invites = {
    SaToken000000000000001: { id: 'SaToken000000000000001', owner: 'sa', ownerName: 'Gil', active: true, createdAt: now - 90 * 24 * H },
    U2Token000000000000001: { id: 'U2Token000000000000001', owner: 'u2', ownerName: 'מיכל לוי', active: true, createdAt: now - 30 * 24 * H },
  };
  let limits = null; // config/limits – null until the superadmin saves (the panel shows the defaults)
  const refs = {};
  const addRef = (id, owner, kind, label = '', leads = 0, active = true) => (refs[id] = { id, owner, kind, label, leads, active, createdAt: now - 20 * 24 * H });
  addRef('gbitman.bd-d87d32', 'sa', 'email'); addRef('gil-d87d32', 'sa', 'name', '', 3); addRef('gil-fb-a', 'sa', 'custom', 'Facebook A', 2); addRef('gil-fb-b', 'sa', 'custom', 'Facebook B', 1);
  addRef('michal.l-m1c4l0', 'u2', 'email'); addRef('michal-m1c4l0', 'u2', 'name', '', 1);
  const reg = (id, name, mobile, ref, hoursAgo, status = 'new', extra = {}) => ({ id, name, mobile, ref, source: ref ? 'link' : 'manual', createdAt: now - hoursAgo * H, status, ...extra });
  const registrations = {
    r1: reg('r1', 'אורי שלום', '0521234567', 'gil-d87d32', 1),
    r2: reg('r2', 'Tamar B', '0547654321', 'gil-fb-a', 5),
    r3: reg('r3', 'שי מזרחי', '0501112233', 'gil-fb-a', 26, 'contacted', { handledBy: 'gbitman.bd@gmail.com', handledAt: now - 20 * H, note: 'יחזור אליי ביום ראשון' }),
    r4: reg('r4', 'נוי כהן', '0587778899', '', 50, 'joined', { handledBy: 'michal.l@example.com', handledAt: now - 40 * H }),
    r5: reg('r5', 'ליאור', '0533334444', 'michal-m1c4l0', 3),
    r6: reg('r6', 'דוד פרץ', '0529990000', 'gil-fb-b', 70, 'rejected', { note: 'לא מתאים' }),
    r7: reg('r7', 'רחל', '0506665555', 'gil-d87d32', 30),
    r8: reg('r8', 'אנונימי', '0501231231', 'someone', 8),
  };

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
    onAuth(cb) { authCb = cb; setTimeout(() => cb({ ...meUser }), 0); return () => {}; },
    signIn: async () => { authCb?.({ ...meUser }); }, signOut: async () => { setTimeout(() => authCb?.(null), 0); },
    watchUsers: (root, cb) => watch(() => cb(Object.values(store[root]).map((u) => clone(u.profile)))),
    getMember: async (uid) => (members[uid] ? clone(members[uid]) : null),
    watchMembers: (cb) => watch(() => cb(clone(Object.values(members)))),
    setMember: async (uid, patch) => { members[uid] = { ...members[uid], ...clone(patch), updatedAt: Date.now(), updatedBy: meUser.email }; emit(); },
    async deleteUser(root, uid, { withData = true } = {}) {
      delete members[uid];
      Object.keys(refs).forEach((k) => { if (refs[k].owner === uid) delete refs[k]; });
      Object.values(invites).forEach((i) => { if (i.owner === uid) i.active = false; });
      if (withData) delete store[root][uid];
      emit();
      return 1;
    },
    watchInvites: (ownerUid, cb) => watch(() => cb(clone(Object.values(invites).filter((i) => !ownerUid || i.owner === ownerUid)))),
    async createInvite(owner, ownerName) { const id = newToken(); invites[id] = { id, owner, ownerName, active: true, createdAt: Date.now() }; emit(); return id; },
    setInvite: async (token, patch) => { Object.assign(invites[token], patch); emit(); },
    watchRefs: (cb) => watch(() => cb(clone(Object.values(refs)))),
    async createRef(id, data) {
      if (refs[id]) throw Object.assign(new Error('ref taken'), { code: 'ref-taken' });
      refs[id] = { id, ...data, active: true, leads: 0, createdAt: Date.now() }; emit();
    },
    updateRef: async (id, patch) => { Object.assign(refs[id], patch); emit(); },
    watchLimits: (cb) => watch(() => cb(limits ? clone(limits) : null)),
    setLimits: async (data) => { limits = { ...clone(data), updatedAt: Date.now(), updatedBy: meUser.email }; emit(); },
    getQuota: async (docId) => (docId.startsWith('routeopt') ? { requests: 5, users: { u1: 3, u2: 2 }, roles: { user: 3, admin: 2 } } : { reads: 14, users: { sa: 14 }, roles: { super: 14 } }),
    watchRegistrations: (cb) => watch(() => cb(clone(Object.values(registrations).sort((a, b) => b.createdAt - a.createdAt)))),
    updateRegistration: async (id, patch) => { Object.assign(registrations[id], patch); emit(); },
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
