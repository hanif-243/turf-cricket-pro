/*
 * Turf Cricket Pro — live sharing (Firebase Firestore).
 *
 * A shared match is an append-only log of operations: matches/{id}/ops/{seq} = { seq, uid, r, a }
 * meaning "remove the last r events, then append events a". Replaying the ops gives the event
 * list the scoring engine replays, so viewers and scorers always derive identical scorecards.
 * Firestore security rules (firestore.rules) only accept op n+1 after op n, so two scorers
 * can never double-count a ball: the slower write is rejected and that phone re-syncs.
 *
 * Firebase is loaded lazily, only when a live feature is used.
 */
(function (root) {
  'use strict';
  const SDK = 'https://www.gstatic.com/firebasejs/12.19.0/';
  let ready = null; // Promise<{ fb, db, auth, uid }>

  function emulatorMode() {
    try { return /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && localStorage.getItem('tcp.emulator') === '1'; } catch (e) { return false; }
  }
  function config() {
    if (emulatorMode()) return { apiKey: 'demo-key', projectId: 'demo-turf-cricket', authDomain: 'localhost' };
    return root.TCP_FIREBASE_CONFIG || null;
  }
  function available() { return !!config(); }

  function init() {
    if (ready) return ready;
    const cfg = config();
    if (!cfg) return Promise.reject(new Error('Live sharing is not set up yet.'));
    ready = (async () => {
      const [appMod, authMod, fs] = await Promise.all([
        import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js'),
      ]);
      const app = appMod.initializeApp(cfg);
      const auth = authMod.getAuth(app);
      let db;
      try {
        db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
      } catch (e) {
        db = fs.getFirestore(app); // persistence unavailable (private mode): memory cache
      }
      if (emulatorMode()) {
        authMod.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
      }
      const user = await new Promise((resolve, reject) => {
        const off = authMod.onAuthStateChanged(auth, u => { if (u) { off(); resolve(u); } }, reject);
        if (!auth.currentUser) authMod.signInAnonymously(auth).catch(reject);
      });
      return { fs, db, auth, uid: user.uid };
    })();
    ready.catch(() => { ready = null; });
    return ready;
  }

  function randomKey(n) {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = new Uint8Array(n || 24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => abc[b % abc.length]).join('');
  }

  // Firestore rejects `undefined` fields; events are plain JSON so a round-trip strips them.
  const clean = v => JSON.parse(JSON.stringify(v));

  // Rebuilds the event list from ordered ops. Stops at the first gap (never shows a half-synced log).
  function eventsFromOps(ops) {
    const events = [];
    let seq = -1;
    for (const o of ops) {
      if (o.seq !== seq + 1) break;
      if (o.r) events.splice(Math.max(0, events.length - o.r), o.r);
      if (o.a && o.a.length) events.push(...o.a);
      seq = o.seq;
    }
    return { events, seq };
  }

  // The op that turns event list `from` into `to`: drop everything after the common prefix, append the rest.
  function diffOp(from, to) {
    let p = 0;
    while (p < from.length && p < to.length && (from[p].id || JSON.stringify(from[p])) === (to[p].id || JSON.stringify(to[p]))) p++;
    return { r: from.length - p, a: to.slice(p) };
  }

  async function goLive(match, photos, ownerName) {
    const { fs, db, uid } = await init();
    const id = match.id;
    const key = randomKey(24);
    const b = fs.writeBatch(db);
    b.set(fs.doc(db, 'matches', id), clean({
      ownerUid: uid, title: match.config.name, config: match.config, potm: match.potm || null,
      paused: !!match.paused, photos: photos || {}, updatedAt: Date.now(),
    }));
    b.set(fs.doc(db, 'matches', id, 'meta', 'head'), { seq: 0 });
    b.set(fs.doc(db, 'matches', id, 'private', 'key'), { key });
    b.set(fs.doc(db, 'matches', id, 'scorers', uid), { name: String(ownerName || 'Owner').slice(0, 40), key: '', joinedAt: Date.now() });
    b.set(fs.doc(db, 'matches', id, 'ops', '0'), clean({ seq: 0, uid, r: 0, a: match.events, ts: Date.now() }));
    await b.commit();
    return { id, key, seq: 0 };
  }

  // Resolves when the server accepts the op; rejects (code 'permission-denied') if another scorer got there first.
  async function push(id, seq, op) {
    const { fs, db, uid } = await init();
    const b = fs.writeBatch(db);
    b.set(fs.doc(db, 'matches', id, 'ops', String(seq)), clean({ seq, uid, r: op.r, a: op.a, ts: Date.now() }));
    b.update(fs.doc(db, 'matches', id, 'meta', 'head'), { seq });
    return b.commit();
  }

  async function updateMeta(id, fields) {
    const { fs, db } = await init();
    return fs.updateDoc(fs.doc(db, 'matches', id), clean(Object.assign({}, fields, { updatedAt: Date.now() })));
  }

  async function join(id, key, name) {
    const { fs, db, uid } = await init();
    await fs.setDoc(fs.doc(db, 'matches', id, 'scorers', uid), { name: String(name || 'Scorer').slice(0, 40), key, joinedAt: Date.now() });
    return uid;
  }

  async function role(id) {
    const { fs, db, uid } = await init();
    const [m, s] = await Promise.all([fs.getDoc(fs.doc(db, 'matches', id)), fs.getDoc(fs.doc(db, 'matches', id, 'scorers', uid))]);
    if (!m.exists()) return null;
    if (m.data().ownerUid === uid) return 'owner';
    return s.exists() ? 'scorer' : 'viewer';
  }

  async function rotateKey(id) {
    const { fs, db } = await init();
    const key = randomKey(24);
    await fs.setDoc(fs.doc(db, 'matches', id, 'private', 'key'), { key });
    return key;
  }

  async function listScorers(id) {
    const { fs, db } = await init();
    const snap = await fs.getDocs(fs.collection(db, 'matches', id, 'scorers'));
    return snap.docs.map(d => ({ uid: d.id, name: d.data().name, joinedAt: d.data().joinedAt }));
  }

  async function removeScorer(id, uid) {
    const { fs, db } = await init();
    return fs.deleteDoc(fs.doc(db, 'matches', id, 'scorers', uid));
  }

  // Live subscription. cb({ meta, events, seq, pending, fromCache }) fires on every change,
  // including this phone's own not-yet-confirmed writes (pending = true).
  function watch(id, cb, onError) {
    let offMeta = null, offOps = null, stopped = false;
    let meta = null, opsState = null, metaPending = false;
    const emit = () => { if (meta && opsState && !stopped) cb(Object.assign({ meta }, opsState, { pending: opsState.pending || metaPending })); };
    init().then(({ fs, db }) => {
      if (stopped) return;
      offMeta = fs.onSnapshot(fs.doc(db, 'matches', id), { includeMetadataChanges: true }, snap => {
        if (!snap.exists()) { if (!snap.metadata.fromCache) onError && onError(new Error('This live match no longer exists.')); return; }
        meta = snap.data(); metaPending = snap.metadata.hasPendingWrites; emit();
      }, err => onError && onError(err));
      const q = fs.query(fs.collection(db, 'matches', id, 'ops'), fs.orderBy('seq'));
      offOps = fs.onSnapshot(q, { includeMetadataChanges: true }, snap => {
        const r = eventsFromOps(snap.docs.map(d => d.data()));
        opsState = { events: r.events, seq: r.seq, pending: snap.metadata.hasPendingWrites, fromCache: snap.metadata.fromCache };
        emit();
      }, err => onError && onError(err));
    }).catch(err => onError && onError(err));
    return () => { stopped = true; if (offMeta) offMeta(); if (offOps) offOps(); };
  }

  async function uid() { return (await init()).uid; }

  const api = { available, emulatorMode, init, uid, goLive, push, updateMeta, join, role, rotateKey, listScorers, removeScorer, watch, diffOp, eventsFromOps, randomKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TCPSync = api;
})(typeof self !== 'undefined' ? self : this);
