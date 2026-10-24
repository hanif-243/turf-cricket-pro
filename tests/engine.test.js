/* Run with: node tests/engine.test.js  (no dependencies) */
'use strict';
const assert = require('assert');
const E = require('../js/engine.js');
const S = require('../js/storage.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ ' + name + '\n      ' + err.message); }
}
function section(name) { console.log('\n' + name); }

// ---------- helpers ----------
function mk(opts = {}) {
  const pps = opts.players || 5;
  const team = (name, pre) => ({ name, players: Array.from({ length: pps }, (_, i) => ({ id: pre + (i + 1), name: pre.toUpperCase() + (i + 1) })) });
  return E.createMatch({
    overs: opts.overs || 2, playersPerSide: pps, maxOversPerBowler: opts.maxOvers,
    teams: [team('Blue', 'a'), team('Red', 'b')],
    toss: { winner: 0, decision: 'bat' }, rules: opts.rules,
  });
}
let seq = 0;
function push(m, ...evs) { evs.forEach(e => m.events.push(Object.assign({ id: 'e' + (++seq) }, e))); return E.replay(m); }
const start = (s = 'a1', ns = 'a2', b = 'b1') => ({ type: 'start_innings', striker: s, nonStriker: ns, bowler: b });
const ball = (runs = 0, extra = {}) => Object.assign({ type: 'ball', kind: 'normal', runs }, extra);
const wd = (runs = 0) => ({ type: 'ball', kind: 'wd', runs });
const nb = (runs = 0, nbType = 'bat') => ({ type: 'ball', kind: 'nb', runs, nbType });
const bowler = id => ({ type: 'set_bowler', bowler: id });
const batter = (id, onStrike) => ({ type: 'new_batter', batter: id, onStrike });
const out = (kind = 'bowled', extra = {}) => Object.assign({ type: 'ball', kind: 'normal', runs: 0, wicket: { kind } }, extra);
const throwsMsg = (fn, re) => assert.throws(fn, err => err instanceof E.ScoringError && re.test(err.message));
const inn = (st, i) => st.innings[i == null ? st.current : i];

// ---------- tests ----------
section('Boundary scoring');
test('four credits batter, bowler and team, keeps strike', () => {
  const m = mk(); const st = push(m, start(), ball(4));
  const i = inn(st);
  assert.strictEqual(i.runs, 4);
  assert.strictEqual(i.batters.a1.runs, 4); assert.strictEqual(i.batters.a1.fours, 1); assert.strictEqual(i.batters.a1.balls, 1);
  assert.strictEqual(i.bowlers.b1.runs, 4); assert.strictEqual(i.striker, 'a1'); assert.strictEqual(i.legalBalls, 1);
});
test('six counts a six; an all-run 4 is not a boundary', () => {
  const m = mk(); const st = push(m, start(), ball(6), ball(4, { boundary: false }));
  const b = inn(st).batters.a1;
  assert.strictEqual(b.sixes, 1); assert.strictEqual(b.fours, 0); assert.strictEqual(b.runs, 10);
});

section('Wides and no-balls');
test('wide adds 1, not a legal ball, no ball faced, charged to bowler', () => {
  const m = mk(); const st = push(m, start(), wd());
  const i = inn(st);
  assert.strictEqual(i.runs, 1); assert.strictEqual(i.legalBalls, 0); assert.strictEqual(i.extras.wd, 1);
  assert.strictEqual(i.batters.a1.balls, 0); assert.strictEqual(i.bowlers.b1.runs, 1); assert.strictEqual(i.bowlers.b1.wides, 1);
});
test('wide with 1 run taken = 2 wides and rotates strike', () => {
  const m = mk(); const st = push(m, start(), wd(1));
  assert.strictEqual(inn(st).extras.wd, 2); assert.strictEqual(inn(st).striker, 'a2');
});
test('no-ball hit for 4: team +5, batter +4 and a ball faced, bowler 5, free hit', () => {
  const m = mk(); const st = push(m, start(), nb(4));
  const i = inn(st);
  assert.strictEqual(i.runs, 5); assert.strictEqual(i.extras.nb, 1); assert.strictEqual(i.legalBalls, 0);
  assert.strictEqual(i.batters.a1.runs, 4); assert.strictEqual(i.batters.a1.balls, 1); assert.strictEqual(i.batters.a1.fours, 1);
  assert.strictEqual(i.bowlers.b1.runs, 5); assert.strictEqual(i.bowlers.b1.noballs, 1); assert.strictEqual(i.freeHit, true);
});
test('free hit: bowled is rejected, cleared after next legal ball', () => {
  const m = mk(); push(m, start(), nb(0));
  throwsMsg(() => push(m, out('bowled')), /Free hit/);
  m.events.pop();
  const st = push(m, ball(0));
  assert.strictEqual(inn(st).freeHit, false);
});
test('no-ball with 2 byes: nb 1 + byes 2, bowler charged 1 only', () => {
  const m = mk(); const st = push(m, start(), nb(2, 'b'));
  const i = inn(st);
  assert.strictEqual(i.runs, 3); assert.strictEqual(i.extras.nb, 1); assert.strictEqual(i.extras.b, 2);
  assert.strictEqual(i.bowlers.b1.runs, 1); assert.strictEqual(i.batters.a1.runs, 0);
});
test('custom rule: 2-run wides', () => {
  const m = mk({ rules: { wideRuns: 2 } }); const st = push(m, start(), wd());
  assert.strictEqual(inn(st).runs, 2);
});

section('Byes and leg byes');
test('byes are legal balls, extras only, dot for bowler, ball faced', () => {
  const m = mk(); const st = push(m, start(), { type: 'ball', kind: 'b', runs: 1 }, { type: 'ball', kind: 'lb', runs: 2 });
  const i = inn(st);
  assert.strictEqual(i.runs, 3); assert.strictEqual(i.legalBalls, 2); assert.strictEqual(i.extras.b, 1); assert.strictEqual(i.extras.lb, 2);
  assert.strictEqual(i.bowlers.b1.runs, 0); assert.strictEqual(i.bowlers.b1.dots, 2);
  assert.strictEqual(i.batters.a2.balls, 1); assert.strictEqual(i.batters.a1.balls, 1); assert.strictEqual(i.batters.a1.runs, 0);
});
test('zero byes without a wicket is rejected', () => {
  const m = mk(); push(m, start());
  throwsMsg(() => push(m, { type: 'ball', kind: 'b', runs: 0 }), /at least one run/);
});

section('Wickets and run-outs');
test('bowled: bowler credited, FOW recorded, needs incoming batter on strike', () => {
  const m = mk(); let st = push(m, start(), ball(2), out('bowled'));
  let i = inn(st);
  assert.strictEqual(i.wickets, 1); assert.strictEqual(i.bowlers.b1.wickets, 1);
  assert.strictEqual(i.batters.a1.howOut, 'b B1');
  assert.deepStrictEqual(i.fow[0], { wicket: 1, runs: 2, overs: '0.2', batter: 'a1' });
  assert.strictEqual(st.needs, 'batter');
  throwsMsg(() => push(m, ball(1)), /incoming batter/);
  m.events.pop();
  st = push(m, batter('a3'));
  i = inn(st);
  assert.strictEqual(i.striker, 'a3'); assert.strictEqual(i.nonStriker, 'a2'); assert.strictEqual(st.needs, null);
});
test('caught with fielder text; caught & bowled', () => {
  const m = mk(); const st = push(m, start(), out('caught', { wicket: { kind: 'caught', fielder: 'b3' } }), batter('a3'),
    out('caught', { wicket: { kind: 'caught', fielder: 'b1' } }));
  const i = inn(st);
  assert.strictEqual(i.batters.a1.howOut, 'c B3 b B1'); assert.strictEqual(i.batters.a3.howOut, 'c & b B1');
});
test('run out of non-striker with 1 run: runs count, no bowler wicket', () => {
  const m = mk(); const st = push(m, start(), ball(1, { wicket: { kind: 'run out', out: 'a2', fielder: 'b4' } }));
  const i = inn(st);
  assert.strictEqual(i.runs, 1); assert.strictEqual(i.wickets, 1); assert.strictEqual(i.bowlers.b1.wickets, 0);
  assert.strictEqual(i.batters.a1.runs, 1); assert.strictEqual(i.batters.a2.out, true);
  assert.strictEqual(i.batters.a2.howOut, 'run out (B4)');
  // a1 crossed to the non-striker end; a2's slot (now striker end) is empty
  assert.strictEqual(i.striker, null); assert.strictEqual(i.nonStriker, 'a1');
});
test('run out on a wide counts the wide, not a bowler wicket', () => {
  const m = mk(); const st = push(m, start(), { type: 'ball', kind: 'wd', runs: 0, wicket: { kind: 'run out', out: 'a1' } });
  const i = inn(st);
  assert.strictEqual(i.runs, 1); assert.strictEqual(i.legalBalls, 0); assert.strictEqual(i.bowlers.b1.wickets, 0);
});
test('stumped off a wide is credited to the bowler', () => {
  const m = mk(); const st = push(m, start(), { type: 'ball', kind: 'wd', runs: 0, wicket: { kind: 'stumped', fielder: 'b2' } });
  assert.strictEqual(inn(st).bowlers.b1.wickets, 1);
});
test('impossible dismissals are rejected', () => {
  const m = mk(); push(m, start());
  throwsMsg(() => push(m, { type: 'ball', kind: 'nb', runs: 0, wicket: { kind: 'bowled' } }), /not possible on a no-ball/);
  m.events.pop();
  throwsMsg(() => push(m, out('caught', { wicket: { kind: 'caught', out: 'a2' } })), /Only the striker/);
  m.events.pop();
  throwsMsg(() => push(m, out('caught', { wicket: { kind: 'caught', fielder: 'a3' } })), /bowling side/);
});

section('Strike rotation');
test('odd runs swap, even runs keep', () => {
  const m = mk(); let st = push(m, start(), ball(1));
  assert.strictEqual(inn(st).striker, 'a2');
  st = push(m, ball(2)); assert.strictEqual(inn(st).striker, 'a2');
  st = push(m, ball(3)); assert.strictEqual(inn(st).striker, 'a1');
  st = push(m, { type: 'swap_strike' }); assert.strictEqual(inn(st).striker, 'a2');
});

section('Over completion');
test('6 legal balls end the over, swap ends, require a new bowler', () => {
  const m = mk(); const st = push(m, start(), ball(0), wd(), ball(0), ball(0), ball(0), ball(0), ball(0));
  const i = inn(st);
  assert.strictEqual(i.legalBalls, 6); assert.strictEqual(E.oversStr(i.legalBalls), '1.0');
  assert.strictEqual(i.striker, 'a2'); assert.strictEqual(i.bowler, null); assert.strictEqual(st.needs, 'bowler');
  assert.strictEqual(i.bowlers.b1.maidens, 0, 'a wide spoils the maiden');
  throwsMsg(() => push(m, bowler('b1')), /previous over/);
});
test('maiden over is recorded; byes do not spoil it', () => {
  const m = mk(); const st = push(m, start(), ball(0), ball(0), { type: 'ball', kind: 'lb', runs: 1 }, ball(0), ball(0), ball(0));
  assert.strictEqual(inn(st).bowlers.b1.maidens, 1);
});
test('single off the last ball keeps the batter on strike for next over', () => {
  const m = mk(); const st = push(m, start(), ball(0), ball(0), ball(0), ball(0), ball(0), ball(1));
  assert.strictEqual(inn(st).striker, 'a1');
});
test('max overs per bowler is enforced', () => {
  const m = mk({ overs: 3, maxOvers: 1 });
  push(m, start(), ...Array(6).fill(ball(0)), bowler('b2'), ...Array(6).fill(ball(0)));
  throwsMsg(() => push(m, bowler('b1')), /maximum 1 overs/);
});
test('overs format: 28 balls = 4.4', () => {
  assert.strictEqual(E.oversStr(28), '4.4'); assert.strictEqual(E.oversShort(24), '4');
  assert.strictEqual(E.rate(61, 37).toFixed(2), '9.89');
});

section('Undo');
test('undo restores exactly the previous state (wicket + partnership + stats)', () => {
  const m = mk(); push(m, start(), ball(4), ball(1), nb(2), ball(0));
  const before = JSON.stringify(E.replay(m));
  push(m, out('bowled'), batter('a3'));
  const r = E.undo(m.events);
  assert.strictEqual(r.removed.length, 2, 'removes the new-batter selection and the wicket ball');
  m.events = r.events;
  assert.strictEqual(JSON.stringify(E.replay(m)), before);
});
test('undo after an over removes the bowler selection and the last ball', () => {
  const m = mk(); push(m, start(), ...Array(5).fill(ball(0)));
  const before = JSON.stringify(E.replay(m));
  push(m, ball(1), bowler('b2'));
  m.events = E.undo(m.events).events;
  assert.strictEqual(JSON.stringify(E.replay(m)), before);
});
test('undo a score correction', () => {
  const m = mk(); push(m, start(), ball(2));
  let st = push(m, { type: 'adjust', runs: 5, note: 'penalty' });
  assert.strictEqual(inn(st).runs, 7); assert.strictEqual(inn(st).extras.pen, 5);
  m.events = E.undo(m.events).events;
  assert.strictEqual(inn(E.replay(m)).runs, 2);
});

section('Innings changes and target');
test('all out ends innings; target = total + 1; teams switch', () => {
  const m = mk({ players: 3 });
  const st = push(m, start(), ball(4), out(), batter('a3'), ball(1), out());
  assert.strictEqual(st.current, 1); assert.strictEqual(st.status, 'innings_break'); assert.strictEqual(st.needs, 'openers');
  assert.strictEqual(inn(st, 0).endReason, 'all out'); assert.strictEqual(inn(st, 0).runs, 5);
  assert.strictEqual(inn(st).target, 6); assert.strictEqual(inn(st).battingTeam, 1); assert.strictEqual(inn(st).bowlingTeam, 0);
});
test('overs complete ends innings; chase figures', () => {
  const m = mk({ overs: 1 });
  let st = push(m, start(), ball(6), ball(6), ball(0), ball(0), ball(0), ball(0));
  assert.strictEqual(st.current, 1); assert.strictEqual(inn(st).target, 13);
  st = push(m, start('b1', 'b2', 'a1'), ball(4), ball(1));
  const c = E.chase(inn(st));
  assert.deepStrictEqual([c.need, c.ballsLeft], [8, 4]); assert.strictEqual(c.rrr, 12);
});
test('bowling team toss decision: toss winner fields first', () => {
  const m = mk(); m.config.toss = { winner: 0, decision: 'bowl' };
  assert.strictEqual(inn(E.replay(m)).battingTeam, 1);
});

section('Results, ties, super over');
function firstInnings(m, runs) { // 1-over innings of `runs` (as singles/boundaries) then 0s
  const balls = [];
  let left = runs;
  while (left >= 6) { balls.push(ball(6)); left -= 6; }
  if (left) balls.push(ball(left % 2 ? left : left)); // single delivery for remainder
  while (balls.length < 6) balls.push(ball(0));
  return push(m, start(), ...balls);
}
test('successful chase: won by wickets with balls left', () => {
  const m = mk({ overs: 1 }); firstInnings(m, 10);
  const st = push(m, start('b1', 'b2', 'a1'), ball(6), ball(6));
  assert.strictEqual(st.status, 'complete'); assert.strictEqual(st.result.winner, 1);
  assert.strictEqual(st.result.text, 'Red won by 4 wickets (4 balls left)');
  throwsMsg(() => push(m, ball(1)), /complete/);
});
test('defended total: won by runs', () => {
  const m = mk({ overs: 1 }); firstInnings(m, 12);
  const st = push(m, start('b1', 'b2', 'a1'), ...Array(6).fill(ball(1)));
  assert.strictEqual(st.result.winner, 0); assert.strictEqual(st.result.text, 'Blue won by 6 runs');
});
test('tie is not a win; super over decides', () => {
  const m = mk({ overs: 1 }); firstInnings(m, 6);
  let st = push(m, start('b1', 'b2', 'a1'), ball(6), ...Array(5).fill(ball(0)));
  assert.strictEqual(st.result.tie, true); assert.strictEqual(st.result.winner, null);
  assert.strictEqual(st.result.text, 'Match tied'); assert.strictEqual(st.result.canSuperOver, true);
  st = push(m, { type: 'start_super_over' });
  assert.strictEqual(inn(st).isSuper, true); assert.strictEqual(inn(st).battingTeam, 1, 'side batting second bats first');
  assert.strictEqual(inn(st).maxWickets, 2);
  st = push(m, start('b1', 'b2', 'a3'), ball(4), ...Array(5).fill(ball(0)));
  assert.strictEqual(inn(st).target, 5);
  st = push(m, start('a1', 'a2', 'b3'), ball(6));
  assert.strictEqual(st.status, 'complete'); assert.strictEqual(st.result.winner, 0);
  assert.strictEqual(st.result.text, 'Match tied — Blue won the Super Over');
});
test('super over disabled: tie stays a tie', () => {
  const m = mk({ overs: 1, rules: { superOver: false } }); firstInnings(m, 0);
  const st = push(m, start('b1', 'b2', 'a1'), ...Array(6).fill(ball(0)));
  assert.strictEqual(st.result.tie, true); assert.strictEqual(st.result.canSuperOver, false);
  throwsMsg(() => push(m, { type: 'start_super_over' }), /after a tie/);
});
test('abandoned match has no winner', () => {
  const m = mk(); const st = push(m, start(), ball(4), { type: 'abandon' });
  assert.strictEqual(st.status, 'abandoned'); assert.strictEqual(st.result.winner, null);
  throwsMsg(() => push(m, ball(1)), /abandoned/);
});
test('declared / ended innings early', () => {
  const m = mk(); const st = push(m, start(), ball(4), { type: 'end_innings' });
  assert.strictEqual(inn(st, 0).endReason, 'declared'); assert.strictEqual(inn(st).target, 5);
});

section('Special rules');
test('last man stands: lone batter keeps strike and bats on', () => {
  const m = mk({ players: 3, rules: { lastManStands: true } });
  let st = push(m, start(), out(), batter('a3'), out());
  let i = inn(st);
  assert.strictEqual(st.status, 'live'); assert.strictEqual(i.striker, 'a2'); assert.strictEqual(i.nonStriker, null); assert.strictEqual(st.needs, null);
  st = push(m, ball(1)); i = inn(st);
  assert.strictEqual(i.striker, 'a2', 'no partner to swap with');
  st = push(m, out());
  assert.strictEqual(inn(st, 0).endReason, 'all out');
});
test('retired hurt is not a wicket and can return', () => {
  const m = mk({ players: 3 });
  let st = push(m, start(), ball(2), { type: 'retire', batter: 'a1', kind: 'hurt' });
  assert.strictEqual(inn(st).wickets, 0); assert.strictEqual(st.needs, 'batter');
  st = push(m, batter('a3'), out());
  assert.ok(E.availableBatters(st, inn(st)).includes('a1'));
  st = push(m, batter('a1'));
  assert.strictEqual(inn(st).batters.a1.retiredHurt, false); assert.strictEqual(inn(st).batters.a1.runs, 2);
});
test('partnership and contributions', () => {
  const m = mk(); const st = push(m, start(), ball(4), ball(1), ball(2), wd());
  const p = inn(st).partnerships[0];
  assert.strictEqual(p.runs, 8); assert.strictEqual(p.balls, 3); assert.deepStrictEqual(p.contrib, { a1: 4 + 1, a2: 2 });
});
test('reset current innings keeps the earlier innings', () => {
  const m = mk({ overs: 1 }); firstInnings(m, 6);
  push(m, start('b1', 'b2', 'a1'), ball(4));
  m.events = E.resetCurrentInnings(m);
  const st = E.replay(m);
  assert.strictEqual(st.current, 1); assert.strictEqual(st.needs, 'openers'); assert.strictEqual(inn(st, 0).runs, 6);
});

section('Config validation');
test('rejects wrong squad size, duplicate players, same team names', () => {
  const t = (name, n, pre = name) => ({ name, players: Array.from({ length: n }, (_, i) => ({ id: pre + i, name: 'P' + i })) });
  const base = { overs: 5, playersPerSide: 4, toss: { winner: 0, decision: 'bat' } };
  throwsMsg(() => E.createMatch(Object.assign({}, base, { teams: [t('A', 3), t('B', 4)] })), /3 players but/);
  throwsMsg(() => E.createMatch(Object.assign({}, base, { teams: [t('A', 4, 'x'), t('B', 4, 'x')] })), /more than once/);
  throwsMsg(() => E.createMatch(Object.assign({}, base, { teams: [t('A', 4), t('a', 4, 'z')] })), /different names/);
  throwsMsg(() => E.createMatch(Object.assign({}, base, { maxOversPerBowler: 1, teams: [t('A', 4), t('B', 4)] })), /can't cover/);
});

section('Reload and restore');
test('JSON round-trip through storage reproduces the identical state', () => {
  const mem = {};
  const backend = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  const store = S.create(backend);
  const m = mk(); push(m, start(), ball(4), nb(1), ball(0), out('caught', { wicket: { kind: 'caught', fielder: 'b2' } }), batter('a3'), ball(3));
  m.summary = E.summarize(E.replay(m));
  store.saveMatch(m); store.setCurrentId(m.id);
  const store2 = S.create(backend); // simulate a page reload
  const loaded = store2.getMatch(store2.getCurrentId());
  assert.strictEqual(JSON.stringify(E.replay(loaded)), JSON.stringify(E.replay(m)));
  assert.strictEqual(store2.getMatchIndex()[0].summary.innings[0].runs, 9);
});
test('backup export / import round-trip', () => {
  const mk2 = () => { const mem = {}; return S.create({ getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } }); };
  const a = mk2(), b = mk2();
  const m = mk(); push(m, start(), ball(6)); m.summary = E.summarize(E.replay(m));
  a.saveMatch(m); a.saveTeam({ id: 't1', name: 'Blue', players: [] });
  const res = b.importAll(JSON.parse(JSON.stringify(a.exportAll())));
  assert.deepStrictEqual(res, { teams: 1, matches: 1 });
  assert.strictEqual(E.replay(b.getMatch(m.id)).innings[0].runs, 6);
});

section('Statistics');
test('career and record aggregation across matches', () => {
  const m1 = mk({ overs: 1 }); firstInnings(m1, 12); push(m1, start('b1', 'b2', 'a1'), ...Array(6).fill(ball(1)));
  const m2 = mk({ overs: 1 }); firstInnings(m2, 6); push(m2, start('b1', 'b2', 'a1'), ball(6), ball(1));
  const entries = [m1, m2].map(match => ({ match, state: E.replay(match) }));
  const s = E.buildStats(entries);
  assert.strictEqual(s.totalMatches, 2);
  const blue = s.teams.find(t => t.name === 'Blue');
  assert.deepStrictEqual([blue.played, blue.won, blue.lost, blue.winPct], [2, 1, 1, 50]);
  assert.strictEqual(s.highestTotal.runs, 12);
  assert.strictEqual(s.highestScore.player, 'A1'); assert.strictEqual(s.highestScore.runs, 12);
  assert.strictEqual(s.players.a1.runs, 18); assert.strictEqual(s.players.a1.sixes, 3);
  const h = E.headToHead(entries, 'n:blue', 'n:red');
  assert.deepStrictEqual([h.played, h.a, h.b], [2, 1, 1]);
});
test('CSV and text exports include the result', () => {
  const m = mk({ overs: 1 }); firstInnings(m, 12); const st = push(m, start('b1', 'b2', 'a1'), ...Array(6).fill(ball(1)));
  assert.ok(E.toCSV(st, {}).includes('Blue won by 6 runs'));
  assert.ok(E.scorecardText(st, { potm: 'a1' }).includes('Player of the Match: A1'));
});

section('Photos and new fields');
test('each delivery records its dismissal kind (for hat-trick detection)', () => {
  const m = mk(); const st = push(m, start(), out('bowled'), batter('a3'), ball(1, { wicket: { kind: 'run out', out: 'a2' } }));
  const d = inn(st).deliveries;
  assert.strictEqual(d[0].wkind, 'bowled'); assert.strictEqual(d[1].wkind, 'run out');
});
test('default team colours are green and purple (colour-blind safe)', () => {
  const t = (name, pre) => ({ name, players: [1, 2].map(i => ({ id: pre + i, name: pre + i })) });
  const m = E.createMatch({ overs: 2, playersPerSide: 2, teams: [t('A', 'x'), t('B', 'y')], toss: { winner: 0, decision: 'bat' } });
  assert.deepStrictEqual(m.config.teams.map(x => x.color), ['#1f9d55', '#7c3aed']);
});
test('photos are stored separately and survive backup export / import', () => {
  const mk2 = () => { const mem = {}; return S.create({ getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } }); };
  const a = mk2(), b = mk2();
  a.setPhoto('p1', 'data:image/jpeg;base64,AAA'); a.setPhoto('t:team1', 'data:image/jpeg;base64,BBB');
  a.setPhoto('p2', 'data:x'); a.setPhoto('p2', null);
  assert.deepStrictEqual(Object.keys(a.getPhotos()).sort(), ['p1', 't:team1']);
  b.importAll(JSON.parse(JSON.stringify(a.exportAll())));
  assert.strictEqual(b.getPhotos().p1, 'data:image/jpeg;base64,AAA');
  b.clearAll(); assert.deepStrictEqual(b.getPhotos(), {});
});

section('Live sync op log');
test('diffOp + eventsFromOps reproduce any edit sequence (score, undo, reset)', () => {
  const Y = require('../js/sync.js');
  const ev = n => ({ id: 'e' + n, type: 'ball', runs: n % 7 });
  const ops = [];
  let cloud = [];
  const send = next => { const op = Y.diffOp(cloud, next); ops.push({ seq: ops.length, r: op.r, a: op.a }); cloud = next; };
  send([ev(1), ev(2)]);                       // go live with two balls
  send([ev(1), ev(2), ev(3)]);                // score
  send([ev(1), ev(2)]);                       // undo
  send([ev(1), ev(2), ev(4), ev(5), ev(6)]);  // more balls
  send([ev(1)]);                              // reset innings
  send([ev(1), ev(7)]);
  assert.deepStrictEqual(ops.map(o => [o.r, o.a.length]), [[0, 2], [0, 1], [1, 0], [0, 3], [4, 0], [0, 1]]);
  const r = Y.eventsFromOps(ops);
  assert.strictEqual(r.seq, 5);
  assert.deepStrictEqual(r.events, cloud);
});
test('eventsFromOps stops at a gap instead of showing a half-synced log', () => {
  const Y = require('../js/sync.js');
  const r = Y.eventsFromOps([{ seq: 0, r: 0, a: [{ id: 'a' }] }, { seq: 2, r: 0, a: [{ id: 'c' }] }]);
  assert.strictEqual(r.seq, 0); assert.strictEqual(r.events.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
