// Security-rules tests. Run with: npm run test:rules  (starts the Firestore emulator)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch } from 'firebase/firestore';

let env;
const KEY = 'k_0123456789abcdefXYZ';
const config = { name: 'Blue vs Red', teams: [] };

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-turf-cricket',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); });

const db = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();
const op = (seq, uid, extra) => Object.assign({ seq, uid, r: 0, a: [{ type: 'ball', runs: seq }], ts: 1 }, extra);

// The owner's "go live" batch: match + head + key + owner as scorer + op 0.
function goLive(fs, uid, id = 'm1', key = KEY) {
  const b = writeBatch(fs);
  b.set(doc(fs, `matches/${id}`), { ownerUid: uid, title: 'Blue vs Red', config, potm: null, paused: false, photos: {}, updatedAt: 1 });
  b.set(doc(fs, `matches/${id}/meta/head`), { seq: 0 });
  b.set(doc(fs, `matches/${id}/private/key`), { key });
  b.set(doc(fs, `matches/${id}/scorers/${uid}`), { name: 'Owner', key: '', joinedAt: 1 });
  b.set(doc(fs, `matches/${id}/ops/0`), op(0, uid, { a: [] }));
  return b.commit();
}
function pushOp(fs, uid, seq, id = 'm1', extra) {
  const b = writeBatch(fs);
  b.set(doc(fs, `matches/${id}/ops/${seq}`), op(seq, uid, extra));
  b.update(doc(fs, `matches/${id}/meta/head`), { seq });
  return b.commit();
}

test('owner can go live; signed-out visitors cannot read', async () => {
  await assertSucceeds(goLive(db('owner'), 'owner'));
  await assertFails(getDoc(doc(db(null), 'matches/m1')));
});

test('cannot go live pretending to be someone else', async () => {
  await assertFails(goLive(db('mallory'), 'owner'));
});

test('viewers can read the match and ops but never write', async () => {
  await goLive(db('owner'), 'owner');
  const v = db('viewer');
  await assertSucceeds(getDoc(doc(v, 'matches/m1')));
  await assertSucceeds(getDoc(doc(v, 'matches/m1/ops/0')));
  await assertFails(pushOp(v, 'viewer', 1));
  await assertFails(updateDoc(doc(v, 'matches/m1'), { potm: 'x' }));
});

test('nobody can read the scorer key', async () => {
  await goLive(db('owner'), 'owner');
  await assertFails(getDoc(doc(db('owner'), 'matches/m1/private/key')));
  await assertFails(getDoc(doc(db('viewer'), 'matches/m1/private/key')));
});

test('joining as scorer needs the right key, then scoring works', async () => {
  await goLive(db('owner'), 'owner');
  const f = db('friend');
  await assertFails(setDoc(doc(f, 'matches/m1/scorers/friend'), { name: 'Friend', key: 'wrong-key-0000000000', joinedAt: 1 }));
  await assertFails(pushOp(f, 'friend', 1));
  await assertSucceeds(setDoc(doc(f, 'matches/m1/scorers/friend'), { name: 'Friend', key: KEY, joinedAt: 1 }));
  await assertSucceeds(pushOp(f, 'friend', 1));
  await assertSucceeds(pushOp(db('owner'), 'owner', 2));
});

test('cannot join on behalf of another device', async () => {
  await goLive(db('owner'), 'owner');
  await assertFails(setDoc(doc(db('friend'), 'matches/m1/scorers/someone'), { name: 'X', key: KEY, joinedAt: 1 }));
});

test('ops must be strictly sequential: no gaps, no repeats, no rewriting', async () => {
  await goLive(db('owner'), 'owner');
  const o = db('owner');
  await assertFails(pushOp(o, 'owner', 2));          // gap
  await assertSucceeds(pushOp(o, 'owner', 1));
  await assertFails(pushOp(o, 'owner', 1));          // the same seq again (a racing second scorer)
  await assertFails(setDoc(doc(o, 'matches/m1/ops/1'), op(1, 'owner', { r: 5 })));
  await assertFails(deleteDoc(doc(o, 'matches/m1/ops/1')));
  await assertFails(updateDoc(doc(o, 'matches/m1/meta/head'), { seq: 7 }));
});

test('two scorers racing for the same ball: exactly one wins', async () => {
  await goLive(db('owner'), 'owner');
  await setDoc(doc(db('friend'), 'matches/m1/scorers/friend'), { name: 'Friend', key: KEY, joinedAt: 1 });
  const results = await Promise.allSettled([pushOp(db('owner'), 'owner', 1), pushOp(db('friend'), 'friend', 1)]);
  assert.strictEqual(results.filter(r => r.status === 'fulfilled').length, 1);
  let head;
  await env.withSecurityRulesDisabled(async c => { head = await getDoc(doc(c.firestore(), 'matches/m1/meta/head')); });
  assert.strictEqual(head.data().seq, 1);
});

test('an op must carry the writer\'s own uid', async () => {
  await goLive(db('owner'), 'owner');
  await assertFails(pushOp(db('owner'), 'friend', 1));
});

test('scorers may update meta but not take ownership', async () => {
  await goLive(db('owner'), 'owner');
  await setDoc(doc(db('friend'), 'matches/m1/scorers/friend'), { name: 'Friend', key: KEY, joinedAt: 1 });
  await assertSucceeds(updateDoc(doc(db('friend'), 'matches/m1'), { potm: 'p1', updatedAt: 2 }));
  await assertFails(updateDoc(doc(db('friend'), 'matches/m1'), { ownerUid: 'friend' }));
});

test('only the owner rotates the key or removes scorers; old key stops working', async () => {
  await goLive(db('owner'), 'owner');
  await setDoc(doc(db('friend'), 'matches/m1/scorers/friend'), { name: 'Friend', key: KEY, joinedAt: 1 });
  await assertFails(setDoc(doc(db('friend'), 'matches/m1/private/key'), { key: 'friend-picked-key-123' }));
  await assertFails(deleteDoc(doc(db('stranger'), 'matches/m1/scorers/friend')));
  await assertSucceeds(setDoc(doc(db('owner'), 'matches/m1/private/key'), { key: 'brand-new-key-0000000' }));
  await assertSucceeds(deleteDoc(doc(db('owner'), 'matches/m1/scorers/friend')));
  await assertFails(pushOp(db('friend'), 'friend', 1));
  await assertFails(setDoc(doc(db('late'), 'matches/m1/scorers/late'), { name: 'Late', key: KEY, joinedAt: 1 }));
});
