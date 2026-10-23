/*
 * Turf Cricket Pro — scoring engine.
 *
 * Pure and UI-free: runs in the browser (window.CricketEngine) and in Node (require).
 * A match is { config, events[] }. The full match state is always rebuilt by replaying
 * the events in order, so undo, reload and (future) multi-device sync are exact:
 * there is no hidden mutable score that can drift from the ball-by-ball record.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CricketEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DISMISSALS = [
    { id: 'bowled', label: 'Bowled' },
    { id: 'caught', label: 'Caught' },
    { id: 'lbw', label: 'LBW' },
    { id: 'run out', label: 'Run out' },
    { id: 'stumped', label: 'Stumped' },
    { id: 'hit wicket', label: 'Hit wicket' },
    { id: 'obstructing', label: 'Obstructing the field' },
  ];
  const DISMISSAL_IDS = DISMISSALS.map(d => d.id);
  // Dismissals credited to the bowler.
  const BOWLER_CREDIT = ['bowled', 'caught', 'lbw', 'stumped', 'hit wicket'];
  // Which dismissals are possible on each delivery type.
  const WICKETS_ON = {
    normal: ['bowled', 'caught', 'lbw', 'run out', 'stumped', 'hit wicket', 'obstructing'],
    wd: ['stumped', 'run out', 'hit wicket', 'obstructing'],
    nb: ['run out', 'obstructing'],
    b: ['run out', 'obstructing'],
    lb: ['run out', 'obstructing'],
  };
  const NON_STRIKER_OUT = ['run out', 'obstructing'];
  const FREE_HIT_OK = ['run out', 'obstructing'];
  const DELIVERY_NAMES = { normal: 'legal delivery', wd: 'wide', nb: 'no-ball', b: 'bye', lb: 'leg bye' };
  // Selections that follow a scoring action; undo removes them together with that action.
  const CONTROL_EVENTS = ['start_innings', 'set_bowler', 'new_batter'];

  class ScoringError extends Error {
    constructor(message) { super(message); this.name = 'ScoringError'; }
  }
  function fail(message) { throw new ScoringError(message); }

  function uid(prefix) {
    const rand = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
    return (prefix || '') + Date.now().toString(36) + rand;
  }

  // ---------- formatting ----------
  const oversStr = balls => `${Math.floor(balls / 6)}.${balls % 6}`;
  const oversShort = balls => (balls % 6 ? oversStr(balls) : String(balls / 6));
  const rate = (runs, balls) => (balls ? (runs * 6) / balls : 0);
  const strikeRate = (runs, balls) => (balls ? (runs * 100) / balls : 0);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---------- config ----------
  function intIn(v, label, min, max, dflt) {
    if (v === undefined || v === null || v === '') {
      if (dflt !== undefined) return dflt;
      fail(`${label} is required`);
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be a whole number from ${min} to ${max}`);
    return n;
  }

  function normalizeConfig(c) {
    if (!c || !Array.isArray(c.teams) || c.teams.length !== 2) fail('Two teams are required');
    const overs = intIn(c.overs, 'Overs', 1, 50);
    const playersPerSide = intIn(c.playersPerSide, 'Players per side', 2, 15);
    const maxOversPerBowler = (c.maxOversPerBowler === '' || c.maxOversPerBowler == null)
      ? null : intIn(c.maxOversPerBowler, 'Max overs per bowler', 1, overs);
    if (maxOversPerBowler && maxOversPerBowler * playersPerSide < overs) {
      fail(`${playersPerSide} bowlers × ${maxOversPerBowler} overs can't cover a ${overs}-over innings`);
    }
    const r = c.rules || {};
    const rules = {
      wideRuns: intIn(r.wideRuns, 'Wide runs', 0, 5, 1),
      noBallRuns: intIn(r.noBallRuns, 'No-ball runs', 0, 5, 1),
      freeHit: r.freeHit !== false,
      lastManStands: !!r.lastManStands,
      superOver: r.superOver !== false,
    };
    const seen = new Set();
    const teams = c.teams.map((t, i) => {
      const name = String((t && t.name) || '').trim();
      if (!name) fail(`Team ${i + 1} needs a name`);
      const players = (t.players || []).map(p => {
        const pname = String((p && p.name) || '').trim();
        if (!pname) fail(`Every player in ${name} needs a name`);
        const id = p.id || uid('p');
        if (seen.has(id)) fail(`${pname} is listed more than once`);
        seen.add(id);
        return { id, name: pname };
      });
      if (players.length !== playersPerSide) {
        fail(`${name} has ${players.length} players but the match is ${playersPerSide}-a-side`);
      }
      const ids = players.map(p => p.id);
      return {
        name,
        color: t.color || (i ? '#3fb6ff' : '#b6f23b'),
        savedTeamId: t.savedTeamId || null,
        captain: ids.includes(t.captain) ? t.captain : null,
        keeper: ids.includes(t.keeper) ? t.keeper : null,
        players,
      };
    });
    if (teams[0].name.toLowerCase() === teams[1].name.toLowerCase()) fail('The two teams need different names');
    const toss = c.toss || {};
    const winner = Number(toss.winner);
    if (winner !== 0 && winner !== 1) fail('Select the toss winner');
    if (toss.decision !== 'bat' && toss.decision !== 'bowl') fail('Select the toss decision');
    return {
      name: String(c.name || '').trim() || `${teams[0].name} vs ${teams[1].name}`,
      date: c.date || new Date().toISOString().slice(0, 10),
      venue: String(c.venue || '').trim(),
      ballType: String(c.ballType || '').trim() || 'Tennis ball',
      format: c.format === 'custom' ? 'custom' : 'standard',
      overs, playersPerSide, maxOversPerBowler, rules, teams,
      toss: { winner, decision: toss.decision },
    };
  }

  function createMatch(input) {
    const now = Date.now();
    return {
      id: (input && input.id) || uid('m'),
      version: 1,
      config: normalizeConfig(input),
      events: [],
      potm: null,
      paused: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  // ---------- state ----------
  function newInnings(cfg, index, battingTeam, eventStart) {
    const isSuper = index >= 2;
    const n = cfg.teams[battingTeam].players.length;
    const maxOvers = isSuper ? 1 : cfg.overs;
    return {
      index, isSuper, battingTeam, bowlingTeam: 1 - battingTeam, eventStart,
      maxOvers, maxBalls: maxOvers * 6,
      maxWickets: isSuper ? Math.min(2, n - 1) : (cfg.rules.lastManStands ? n : n - 1),
      target: null, runs: 0, wickets: 0, legalBalls: 0,
      extras: { wd: 0, nb: 0, b: 0, lb: 0, pen: 0 },
      batters: {}, battingOrder: [], bowlers: {}, bowlingOrder: [],
      fow: [], partnerships: [], deliveries: [], adjustments: [],
      striker: null, nonStriker: null, bowler: null, lastOverBowler: null,
      overDeliveries: 0, overBowlerRuns: 0, overBowler: null, overClean: true,
      freeHit: false, started: false, complete: false, endReason: null,
    };
  }

  function initState(cfg) {
    const names = {}, teamOf = {};
    cfg.teams.forEach((t, ti) => t.players.forEach(p => { names[p.id] = p.name; teamOf[p.id] = ti; }));
    const first = cfg.toss.decision === 'bat' ? cfg.toss.winner : 1 - cfg.toss.winner;
    const st = {
      config: cfg, names, teamOf,
      innings: [newInnings(cfg, 0, first, 0)],
      current: 0, status: 'ready', result: null, needs: null,
      cursor: 0, applied: 0,
    };
    refresh(st);
    return st;
  }

  function replay(match) {
    const st = initState(match.config);
    match.events.forEach((e, i) => {
      try { applyEvent(st, e); } catch (err) { err.eventIndex = i; throw err; }
    });
    return st;
  }

  function teamName(st, i) { return st.config.teams[i].name; }
  function current(st) { return st.innings[st.current]; }
  function atCrease(inn, id) { return id === inn.striker || id === inn.nonStriker; }

  function availableBatters(st, inn) {
    return st.config.teams[inn.battingTeam].players.map(p => p.id).filter(id => {
      const b = inn.batters[id];
      return !b || (b.retiredHurt && !atCrease(inn, id));
    });
  }
  function needsBatter(st, inn) {
    return (!inn.striker || !inn.nonStriker) && availableBatters(st, inn).length > 0;
  }

  function batterRec(st, inn, id) {
    if (!inn.batters[id]) {
      inn.batters[id] = { id, name: st.names[id], runs: 0, balls: 0, fours: 0, sixes: 0, out: false, retiredHurt: false, howOut: null, dismissal: null };
      inn.battingOrder.push(id);
    }
    return inn.batters[id];
  }
  function bowlerRec(st, inn, id) {
    if (!inn.bowlers[id]) {
      inn.bowlers[id] = { id, name: st.names[id], balls: 0, runs: 0, wickets: 0, maidens: 0, wides: 0, noballs: 0, dots: 0 };
      inn.bowlingOrder.push(id);
    }
    return inn.bowlers[id];
  }

  function openPartnership(inn) {
    const p = inn.partnerships[inn.partnerships.length - 1];
    return p && p.open ? p : null;
  }
  function startPartnership(inn) {
    const ids = [inn.striker, inn.nonStriker].filter(Boolean);
    if (!ids.length) return;
    const contrib = {};
    ids.forEach(id => { contrib[id] = 0; });
    inn.partnerships.push({ batters: ids, runs: 0, balls: 0, contrib, open: true, endWicket: null });
  }
  function closePartnership(inn, wicketNo) {
    const p = openPartnership(inn);
    if (p) { p.open = false; p.endWicket = wicketNo == null ? null : wicketNo; }
  }
  function swapEnds(inn) {
    const s = inn.striker;
    inn.striker = inn.nonStriker;
    inn.nonStriker = s;
  }

  function refresh(st) {
    if (st.status === 'abandoned' || st.status === 'complete') { st.needs = null; return; }
    const inn = current(st);
    st.needs = null;
    if (!inn.started) {
      st.status = st.current === 0 ? 'ready' : 'innings_break';
      st.needs = 'openers';
      return;
    }
    st.status = 'live';
    // Last man stands: the lone batter always takes strike.
    if (!inn.striker && inn.nonStriker && !availableBatters(st, inn).length) swapEnds(inn);
    if (needsBatter(st, inn)) { st.needs = 'batter'; return; }
    if (!openPartnership(inn)) startPartnership(inn);
    if (!inn.bowler) st.needs = 'bowler';
  }

  function requireActive(st, inn) {
    if (st.status === 'abandoned') fail('This match was abandoned');
    if (st.status === 'complete') fail('The match is complete. Undo the last ball to make changes.');
    if (!inn.started) fail('Select the opening batters and bowler first');
  }

  // ---------- events ----------
  function applyEvent(st, e) {
    if (!e || typeof e.type !== 'string') fail('Invalid scoring event');
    st.cursor = st.applied;
    const inn = current(st);
    switch (e.type) {
      case 'start_innings': startInnings(st, inn, e); break;
      case 'ball': ball(st, inn, e); break;
      case 'set_bowler': setBowler(st, inn, e.bowler); break;
      case 'new_batter': newBatter(st, inn, e); break;
      case 'swap_strike':
        requireActive(st, inn);
        if (!inn.nonStriker) fail('There is only one batter at the crease');
        swapEnds(inn);
        break;
      case 'retire': retire(st, inn, e); break;
      case 'adjust': adjust(st, inn, e); break;
      case 'end_innings':
        requireActive(st, inn);
        endInnings(st, inn, e.reason || 'declared');
        break;
      case 'start_super_over': startSuperOver(st); break;
      case 'abandon':
        if (st.status === 'complete') fail('The match is already complete');
        if (st.status === 'abandoned') fail('The match is already abandoned');
        st.status = 'abandoned';
        st.result = { winner: null, tie: false, abandoned: true, text: 'Match abandoned — no result' };
        break;
      default: fail(`Unknown event type: ${e.type}`);
    }
    st.applied++;
    refresh(st);
  }

  function startInnings(st, inn, e) {
    if (st.status === 'complete' || st.status === 'abandoned') fail('The match is over');
    if (inn.started) fail('This innings has already started');
    if (st.teamOf[e.striker] !== inn.battingTeam || st.teamOf[e.nonStriker] !== inn.battingTeam) {
      fail(`Select two opening batters from ${teamName(st, inn.battingTeam)}`);
    }
    if (e.striker === e.nonStriker) fail('The opening batters must be different players');
    inn.started = true;
    batterRec(st, inn, e.striker);
    batterRec(st, inn, e.nonStriker);
    inn.striker = e.striker;
    inn.nonStriker = e.nonStriker;
    setBowler(st, inn, e.bowler);
  }

  // Returns a reason the player can't bowl now, or null.
  function bowlerBlock(st, inn, id) {
    const name = st.names[id];
    if (st.teamOf[id] !== inn.bowlingTeam) return `Select a bowler from ${teamName(st, inn.bowlingTeam)}`;
    if (id === inn.bowler) return `${name} is already bowling`;
    if (id === inn.lastOverBowler) return `${name} bowled the previous over`;
    const max = st.config.maxOversPerBowler;
    const rec = inn.bowlers[id];
    if (max && !inn.isSuper && rec && rec.balls >= max * 6) return `${name} has bowled the maximum ${max} overs`;
    return null;
  }

  function setBowler(st, inn, id) {
    if (!inn.started || inn.complete) fail('No innings in progress');
    const block = bowlerBlock(st, inn, id);
    if (block) fail(block);
    bowlerRec(st, inn, id);
    if (inn.overDeliveries > 0) inn.overClean = false; // mid-over change: no maiden this over
    else inn.overBowler = id;
    inn.bowler = id;
  }

  function newBatter(st, inn, e) {
    requireActive(st, inn);
    const id = e.batter;
    if (!availableBatters(st, inn).includes(id)) fail('That player is not available to bat');
    const slot = !inn.striker ? 'striker' : (!inn.nonStriker ? 'nonStriker' : null);
    if (!slot) fail('Both batters are already at the crease');
    const rec = batterRec(st, inn, id);
    if (rec.retiredHurt) { rec.retiredHurt = false; rec.howOut = null; }
    inn[slot] = id;
    if (typeof e.onStrike === 'boolean' && (slot === 'striker') !== e.onStrike && inn.striker && inn.nonStriker) swapEnds(inn);
  }

  function dismissalText(st, kind, bowlerId, fielderId) {
    const b = st.names[bowlerId];
    const f = fielderId ? st.names[fielderId] : null;
    switch (kind) {
      case 'bowled': return `b ${b}`;
      case 'caught':
        if (fielderId && fielderId === bowlerId) return `c & b ${b}`;
        return f ? `c ${f} b ${b}` : `caught, b ${b}`;
      case 'lbw': return `lbw b ${b}`;
      case 'stumped': return f ? `st ${f} b ${b}` : `stumped, b ${b}`;
      case 'run out': return f ? `run out (${f})` : 'run out';
      case 'hit wicket': return `hit wicket b ${b}`;
      case 'obstructing': return 'obstructing the field';
      default: return kind;
    }
  }

  function validateWicket(st, inn, kind, w) {
    const label = (DISMISSALS.find(d => d.id === w.kind) || {}).label;
    if (!label) fail('Select how the batter was out');
    if (!WICKETS_ON[kind].includes(w.kind)) fail(`${label} is not possible on a ${DELIVERY_NAMES[kind]}`);
    const out = w.out || inn.striker;
    if (out !== inn.striker && out !== inn.nonStriker) fail('The dismissed batter must be at the crease');
    if (out !== inn.striker && !NON_STRIKER_OUT.includes(w.kind)) fail(`Only the striker can be out ${label.toLowerCase()}`);
    if (st.config.rules.freeHit && inn.freeHit && !FREE_HIT_OK.includes(w.kind)) fail('Free hit: the batter can only be run out');
    if (w.fielder && st.teamOf[w.fielder] !== inn.bowlingTeam) fail('The fielder must be from the bowling side');
  }

  function ballLabel(kind, runs, teamRuns, nbType, wicket) {
    let base;
    if (kind === 'normal') base = runs === 0 ? '•' : String(runs);
    else if (kind === 'wd') base = teamRuns === 1 ? 'Wd' : `${teamRuns}Wd`;
    else if (kind === 'nb') base = runs ? `Nb+${runs}${nbType === 'bat' ? '' : nbType}` : 'Nb';
    else base = `${runs}${kind === 'b' ? 'B' : 'Lb'}`;
    if (!wicket) return base;
    return kind === 'normal' && runs === 0 ? 'W' : `${base}+W`;
  }

  function ball(st, inn, e) {
    requireActive(st, inn);
    if (needsBatter(st, inn)) fail('Select the incoming batter first');
    if (!inn.bowler) fail('Select the bowler for this over first');
    if (!inn.striker) fail('No batter on strike');
    const rules = st.config.rules;
    const kind = e.kind || 'normal';
    if (!WICKETS_ON[kind]) fail('Unknown delivery type');
    const runs = Number(e.runs || 0);
    if (!Number.isInteger(runs) || runs < 0 || runs > 10) fail('Runs must be a whole number from 0 to 10');
    if ((kind === 'b' || kind === 'lb') && runs === 0 && !e.wicket) fail('Byes and leg byes need at least one run');
    const nbType = kind === 'nb' ? (e.nbType || 'bat') : null;
    if (nbType && !['bat', 'b', 'lb'].includes(nbType)) fail('Unknown no-ball run type');
    const w = e.wicket || null;
    if (w) validateWicket(st, inn, kind, w);

    const strikerId = inn.striker, bowlerId = inn.bowler;
    const S = inn.batters[strikerId], B = inn.bowlers[bowlerId];
    const legal = kind !== 'wd' && kind !== 'nb';
    const boundary = e.boundary !== false && (runs === 4 || runs === 6);
    let teamRuns = 0, bowlerRuns = 0, batRuns = 0;

    if (kind === 'normal') {
      batRuns = runs; teamRuns = runs; bowlerRuns = runs;
    } else if (kind === 'wd') {
      teamRuns = rules.wideRuns + runs; // runs taken off a wide are all wides
      inn.extras.wd += teamRuns; bowlerRuns = teamRuns; B.wides++;
    } else if (kind === 'nb') {
      inn.extras.nb += rules.noBallRuns; B.noballs++;
      teamRuns = rules.noBallRuns + runs; bowlerRuns = rules.noBallRuns;
      if (nbType === 'bat') { batRuns = runs; bowlerRuns += runs; } else inn.extras[nbType] += runs;
    } else {
      inn.extras[kind] += runs; teamRuns = runs; // byes / leg byes: not against the bowler
    }
    if (kind !== 'wd') S.balls++;
    S.runs += batRuns;
    if (batRuns && boundary) { if (runs === 4) S.fours++; else S.sixes++; }
    B.runs += bowlerRuns;
    inn.runs += teamRuns;
    const p = openPartnership(inn);
    if (p) {
      p.runs += teamRuns;
      if (legal) p.balls++;
      p.contrib[strikerId] = (p.contrib[strikerId] || 0) + batRuns;
    }
    const ballsBefore = inn.legalBalls;
    inn.overDeliveries++;
    inn.overBowlerRuns += bowlerRuns;
    if (legal) { inn.legalBalls++; B.balls++; if (bowlerRuns === 0) B.dots++; }

    let outId = null;
    if (w) {
      outId = w.out || strikerId;
      const O = inn.batters[outId];
      O.out = true;
      O.dismissal = { kind: w.kind, bowler: bowlerId, fielder: w.fielder || null };
      O.howOut = dismissalText(st, w.kind, bowlerId, w.fielder);
      inn.wickets++;
      if (BOWLER_CREDIT.includes(w.kind)) B.wickets++;
      inn.fow.push({ wicket: inn.wickets, runs: inn.runs, overs: oversStr(inn.legalBalls), batter: outId });
      closePartnership(inn, inn.wickets);
    }

    if (rules.freeHit) {
      if (kind === 'nb') inn.freeHit = true;
      else if (legal) inn.freeHit = false;
    }

    if (runs % 2 === 1) swapEnds(inn); // completed runs rotate the strike
    if (outId) {
      if (inn.striker === outId) inn.striker = null;
      else inn.nonStriker = null;
    }

    inn.deliveries.push({
      id: e.id || null, over: Math.floor(ballsBefore / 6), legal, kind, runs, teamRuns, batRuns,
      wicket: !!w, out: outId, bowler: bowlerId, striker: strikerId,
      boundary: !!(batRuns && boundary),
      label: ballLabel(kind, runs, teamRuns, nbType, w),
    });

    if (legal && inn.legalBalls % 6 === 0) {
      if (inn.overClean && inn.overBowler === bowlerId && inn.overBowlerRuns === 0) B.maidens++;
      swapEnds(inn);
      inn.lastOverBowler = bowlerId;
      inn.bowler = null;
      inn.overDeliveries = 0; inn.overBowlerRuns = 0; inn.overClean = true; inn.overBowler = null;
    }
    checkInningsEnd(st, inn);
  }

  function retire(st, inn, e) {
    requireActive(st, inn);
    const id = e.batter;
    if (!atCrease(inn, id)) fail('Only a batter at the crease can retire');
    const R = inn.batters[id];
    if (e.kind === 'out') {
      R.out = true; R.howOut = 'retired out'; R.dismissal = { kind: 'retired out' };
      inn.wickets++;
      inn.fow.push({ wicket: inn.wickets, runs: inn.runs, overs: oversStr(inn.legalBalls), batter: id });
      closePartnership(inn, inn.wickets);
    } else {
      R.retiredHurt = true; R.howOut = 'retired hurt';
      closePartnership(inn, null);
    }
    if (inn.striker === id) inn.striker = null; else inn.nonStriker = null;
    checkInningsEnd(st, inn);
  }

  function adjust(st, inn, e) {
    requireActive(st, inn);
    const runs = Number(e.runs);
    if (!Number.isInteger(runs) || runs === 0 || Math.abs(runs) > 50) fail('Correction must be a whole number from -50 to 50, not 0');
    if (inn.runs + runs < 0) fail('The score cannot go below zero');
    inn.runs += runs;
    inn.extras.pen += runs;
    inn.adjustments.push({ runs, note: String(e.note || '').slice(0, 120), atBalls: inn.legalBalls });
    checkInningsEnd(st, inn);
  }

  function checkInningsEnd(st, inn) {
    if (inn.complete) return;
    if (inn.target != null && inn.runs >= inn.target) endInnings(st, inn, 'target');
    else if (inn.wickets >= inn.maxWickets) endInnings(st, inn, 'all out');
    else if (inn.legalBalls >= inn.maxBalls) endInnings(st, inn, 'overs');
  }

  function endInnings(st, inn, reason) {
    inn.complete = true;
    inn.endReason = reason;
    closePartnership(inn, null);
    if (inn.index % 2 === 0) {
      const next = newInnings(st.config, inn.index + 1, inn.bowlingTeam, st.cursor + 1);
      next.target = inn.runs + 1;
      st.innings.push(next);
      st.current = next.index;
    } else {
      st.result = computeResult(st, st.innings[inn.index - 1], inn);
      st.status = 'complete';
    }
  }

  function computeResult(st, a, b) {
    const T = i => teamName(st, i);
    let r;
    if (b.runs >= b.target) {
      const margin = b.maxWickets - b.wickets, ballsLeft = b.maxBalls - b.legalBalls;
      r = { winner: b.battingTeam, by: 'wickets', margin, ballsLeft, tie: false };
      r.text = b.isSuper
        ? `Match tied — ${T(r.winner)} won the Super Over`
        : `${T(r.winner)} won by ${plural(margin, 'wicket')}` + (ballsLeft > 0 ? ` (${plural(ballsLeft, 'ball')} left)` : '');
    } else if (b.runs === b.target - 1) {
      r = { winner: null, tie: true, text: b.isSuper ? 'Super Over tied' : 'Match tied' };
    } else {
      const margin = b.target - 1 - b.runs;
      r = { winner: a.battingTeam, by: 'runs', margin, tie: false };
      r.text = b.isSuper ? `Match tied — ${T(r.winner)} won the Super Over` : `${T(r.winner)} won by ${plural(margin, 'run')}`;
    }
    r.superOver = b.isSuper;
    r.canSuperOver = r.tie && st.config.rules.superOver;
    return r;
  }

  function startSuperOver(st) {
    if (st.status !== 'complete' || !st.result || !st.result.canSuperOver) fail('A Super Over can only start after a tie');
    const last = current(st);
    // The side that batted second in the tied contest bats first in the Super Over.
    const inn = newInnings(st.config, last.index + 1, last.battingTeam, st.cursor + 1);
    st.innings.push(inn);
    st.current = inn.index;
    st.result = null;
    st.status = 'innings_break';
  }

  // ---------- undo / reset ----------
  function undo(events) {
    const ev = events.slice();
    const removed = [];
    while (ev.length && CONTROL_EVENTS.includes(ev[ev.length - 1].type)) removed.unshift(ev.pop());
    if (ev.length) removed.unshift(ev.pop());
    return { events: ev, removed };
  }

  // Events that recreate the match up to the start of the current innings.
  function resetCurrentInnings(match) {
    const st = replay(match);
    return match.events.slice(0, current(st).eventStart);
  }

  function describeEvent(e, names) {
    const n = id => (names && names[id]) || 'player';
    switch (e.type) {
      case 'ball': {
        const k = { normal: '', wd: 'wide', nb: 'no-ball', b: 'byes', lb: 'leg byes' }[e.kind || 'normal'];
        const r = e.runs ? plural(e.runs, 'run') : 'dot ball';
        return (e.wicket ? 'wicket' : '') + (e.wicket && (k || e.runs) ? ' + ' : '') + (k ? `${k}${e.runs ? ' ' + e.runs : ''}` : (e.wicket ? (e.runs ? r : '') : r));
      }
      case 'start_innings': return 'opening selection';
      case 'set_bowler': return `bowler ${n(e.bowler)}`;
      case 'new_batter': return `new batter ${n(e.batter)}`;
      case 'swap_strike': return 'strike change';
      case 'retire': return `${n(e.batter)} retired`;
      case 'adjust': return `score correction ${e.runs > 0 ? '+' : ''}${e.runs}`;
      case 'end_innings': return 'end of innings';
      case 'start_super_over': return 'Super Over start';
      case 'abandon': return 'abandonment';
      default: return e.type;
    }
  }

  // ---------- derived views ----------
  // Deliveries since the 6th-last legal ball (so extras in between are shown too).
  function recentDeliveries(inn, legalCount) {
    const want = legalCount || 6;
    const out = [];
    let legal = 0;
    for (let i = inn.deliveries.length - 1; i >= 0 && legal < want; i--) {
      out.unshift(inn.deliveries[i]);
      if (inn.deliveries[i].legal) legal++;
    }
    return out;
  }

  function chase(inn) {
    if (inn.target == null) return null;
    const need = Math.max(0, inn.target - inn.runs);
    const ballsLeft = Math.max(0, inn.maxBalls - inn.legalBalls);
    return { target: inn.target, need, ballsLeft, rrr: ballsLeft ? (need * 6) / ballsLeft : null };
  }

  function playersOf(st, team) { return st.config.teams[team].players; }

  function awards(st) {
    let bat = null, bowl = null;
    st.innings.filter(i => i.started && !i.isSuper).forEach(inn => {
      Object.values(inn.batters).forEach(b => {
        if (!bat || b.runs > bat.runs || (b.runs === bat.runs && b.balls < bat.balls)) bat = Object.assign({ team: inn.battingTeam }, b);
      });
      Object.values(inn.bowlers).forEach(b => {
        if (!b.balls && !b.wickets) return;
        if (!bowl || b.wickets > bowl.wickets || (b.wickets === bowl.wickets && b.runs < bowl.runs)) bowl = Object.assign({ team: inn.bowlingTeam }, b);
      });
    });
    return { bestBatter: bat && bat.balls ? bat : null, bestBowler: bowl };
  }

  function summarize(st) {
    return {
      status: st.status,
      result: st.result ? st.result.text : null,
      winner: st.result ? st.result.winner : null,
      tie: !!(st.result && st.result.tie),
      teams: st.config.teams.map(t => ({ name: t.name, color: t.color, savedTeamId: t.savedTeamId })),
      innings: st.innings.filter(i => i.started).map(i => ({
        team: i.battingTeam, runs: i.runs, wickets: i.wickets, overs: oversStr(i.legalBalls), isSuper: i.isSuper,
      })),
    };
  }

  function inningsTitle(st, inn) {
    const base = teamName(st, inn.battingTeam);
    return inn.isSuper ? `${base} — Super Over` : base;
  }

  function extrasTotal(inn) { const x = inn.extras; return x.wd + x.nb + x.b + x.lb + x.pen; }
  function extrasLine(inn) {
    const x = inn.extras;
    return `${extrasTotal(inn)} (b ${x.b}, lb ${x.lb}, wd ${x.wd}, nb ${x.nb}${x.pen ? `, pen ${x.pen}` : ''})`;
  }
  function scoreLine(inn) { return `${inn.runs}/${inn.wickets} (${oversStr(inn.legalBalls)} ov)`; }

  function scorecardText(st, meta) {
    const cfg = st.config;
    const L = [];
    L.push(`🏏 ${cfg.name}`);
    L.push([cfg.date, cfg.venue, `${cfg.overs} overs`, `${cfg.playersPerSide}-a-side`].filter(Boolean).join(' · '));
    L.push('');
    st.innings.filter(i => i.started).forEach(inn => {
      L.push(`${inningsTitle(st, inn)}: ${scoreLine(inn)}`);
      inn.battingOrder.forEach(id => {
        const b = inn.batters[id];
        L.push(`  ${b.name} ${b.runs} (${b.balls})${b.out ? ' — ' + b.howOut : (b.retiredHurt ? ' — retired hurt' : ' not out')}`);
      });
      L.push(`  Extras ${extrasLine(inn)}`);
      inn.bowlingOrder.forEach(id => {
        const b = inn.bowlers[id];
        L.push(`  ${b.name} ${oversShort(b.balls)}-${b.maidens}-${b.runs}-${b.wickets}`);
      });
      if (inn.fow.length) L.push(`  FoW: ${inn.fow.map(f => `${f.runs}-${f.wicket} (${st.names[f.batter]}, ${f.overs})`).join(', ')}`);
      L.push('');
    });
    L.push(`Result: ${st.result ? st.result.text : (st.status === 'abandoned' ? 'Abandoned' : 'In progress')}`);
    if (meta && meta.potm && st.names[meta.potm]) L.push(`Player of the Match: ${st.names[meta.potm]}`);
    return L.join('\n');
  }

  function shareText(st, meta) {
    const cfg = st.config;
    const L = [`🏏 ${cfg.name}${cfg.venue ? ' @ ' + cfg.venue : ''}`];
    st.innings.filter(i => i.started).forEach(inn => L.push(`${inningsTitle(st, inn)} ${scoreLine(inn)}`));
    const c = st.status === 'live' ? chase(current(st)) : null;
    if (c) L.push(`Need ${c.need} from ${c.ballsLeft} balls`);
    if (st.result) L.push(st.result.text);
    const a = awards(st);
    if (a.bestBatter) L.push(`Top bat: ${a.bestBatter.name} ${a.bestBatter.runs} (${a.bestBatter.balls})`);
    if (a.bestBowler) L.push(`Top bowl: ${a.bestBowler.name} ${a.bestBowler.wickets}/${a.bestBowler.runs}`);
    if (meta && meta.potm && st.names[meta.potm]) L.push(`POTM: ${st.names[meta.potm]}`);
    L.push('— Turf Cricket Pro');
    return L.join('\n');
  }

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function toCSV(st, meta) {
    const cfg = st.config;
    const rows = [];
    const row = (...c) => rows.push(c.map(csvCell).join(','));
    row('Match', cfg.name); row('Date', cfg.date); row('Venue', cfg.venue); row('Overs', cfg.overs);
    row('Players per side', cfg.playersPerSide); row('Ball', cfg.ballType);
    row('Toss', `${teamName(st, cfg.toss.winner)} chose to ${cfg.toss.decision}`);
    row('Result', st.result ? st.result.text : st.status);
    if (meta && meta.potm) row('Player of the Match', st.names[meta.potm] || '');
    st.innings.filter(i => i.started).forEach(inn => {
      row(); row(`Innings ${inn.index + 1}`, inningsTitle(st, inn), scoreLine(inn));
      row('Batter', 'Dismissal', 'R', 'B', '4s', '6s', 'SR');
      inn.battingOrder.forEach(id => {
        const b = inn.batters[id];
        row(b.name, b.out ? b.howOut : (b.retiredHurt ? 'retired hurt' : 'not out'), b.runs, b.balls, b.fours, b.sixes, strikeRate(b.runs, b.balls).toFixed(2));
      });
      row('Extras', extrasLine(inn)); row('Total', scoreLine(inn));
      row('Bowler', 'O', 'M', 'R', 'W', 'Econ', 'Wd', 'Nb');
      inn.bowlingOrder.forEach(id => {
        const b = inn.bowlers[id];
        row(b.name, oversShort(b.balls), b.maidens, b.runs, b.wickets, rate(b.runs, b.balls).toFixed(2), b.wides, b.noballs);
      });
      row('Fall of wickets'); inn.fow.forEach(f => row(`${f.runs}-${f.wicket}`, st.names[f.batter], f.overs));
      row('Ball by ball', 'Over', 'Bowler', 'Batter', 'Outcome', 'Team runs');
      inn.deliveries.forEach(d => row('', d.over + 1, st.names[d.bowler], st.names[d.striker], d.label, d.teamRuns));
    });
    return rows.join('\n');
  }

  // ---------- multi-match statistics ----------
  function teamKey(t) { return t.savedTeamId ? 't:' + t.savedTeamId : 'n:' + t.name.trim().toLowerCase(); }

  function buildStats(entries) {
    const teams = {}, players = {};
    let highestTotal = null, highestScore = null, bestBowling = null;
    const done = entries.filter(x => x.state.status === 'complete' || x.state.status === 'abandoned');
    done.forEach(({ match, state }) => {
      const cfg = state.config;
      const res = state.result;
      cfg.teams.forEach((t, i) => {
        const key = teamKey(t);
        const T = teams[key] || (teams[key] = { key, name: t.name, savedTeamId: t.savedTeamId, played: 0, won: 0, lost: 0, tied: 0, nr: 0 });
        T.name = t.name;
        T.played++;
        if (state.status === 'abandoned') T.nr++;
        else if (res.winner === i) T.won++;
        else if (res.winner == null) T.tied++;
        else T.lost++;
        t.players.forEach(p => {
          const P = players[p.id] || (players[p.id] = {
            id: p.id, name: p.name, team: t.name, matches: 0, innings: 0, notOuts: 0, runs: 0, balls: 0, fours: 0, sixes: 0,
            hs: 0, hsNotOut: false, fifties: 0, ballsBowled: 0, runsConceded: 0, wickets: 0, best: null,
          });
          P.name = p.name; P.team = t.name; P.matches++;
        });
      });
      state.innings.filter(inn => inn.started && !inn.isSuper).forEach(inn => {
        const tname = teamName(state, inn.battingTeam);
        if (!highestTotal || inn.runs > highestTotal.runs) {
          highestTotal = { runs: inn.runs, wickets: inn.wickets, overs: oversStr(inn.legalBalls), team: tname, matchId: match.id, matchName: cfg.name };
        }
        Object.values(inn.batters).forEach(b => {
          const P = players[b.id];
          P.innings++; P.runs += b.runs; P.balls += b.balls; P.fours += b.fours; P.sixes += b.sixes;
          if (!b.out) P.notOuts++;
          if (b.runs >= 50) P.fifties++;
          if (b.runs > P.hs || (b.runs === P.hs && !b.out)) { P.hs = b.runs; P.hsNotOut = !b.out; }
          if (!highestScore || b.runs > highestScore.runs) {
            highestScore = { runs: b.runs, balls: b.balls, notOut: !b.out, player: b.name, playerId: b.id, team: tname, matchId: match.id, matchName: cfg.name };
          }
        });
        Object.values(inn.bowlers).forEach(b => {
          const P = players[b.id];
          P.ballsBowled += b.balls; P.runsConceded += b.runs; P.wickets += b.wickets;
          if (!P.best || b.wickets > P.best.wickets || (b.wickets === P.best.wickets && b.runs < P.best.runs)) P.best = { wickets: b.wickets, runs: b.runs };
          if (b.balls && (!bestBowling || b.wickets > bestBowling.wickets || (b.wickets === bestBowling.wickets && b.runs < bestBowling.runs))) {
            bestBowling = { wickets: b.wickets, runs: b.runs, overs: oversShort(b.balls), player: b.name, playerId: b.id, team: teamName(state, inn.bowlingTeam), matchId: match.id, matchName: cfg.name };
          }
        });
      });
    });
    const teamList = Object.values(teams).map(t => Object.assign(t, {
      winPct: t.played - t.nr ? Math.round((t.won * 1000) / (t.played - t.nr)) / 10 : 0,
    })).sort((a, b) => b.won - a.won || b.winPct - a.winPct);
    const list = Object.values(players);
    const top = f => list.filter(p => f(p) > 0).sort((a, b) => f(b) - f(a))[0] || null;
    return {
      totalMatches: done.length,
      completed: done.filter(x => x.state.status === 'complete').length,
      teams: teamList, players, highestTotal, highestScore, bestBowling,
      mostRuns: top(p => p.runs), mostWickets: top(p => p.wickets),
      mostFours: top(p => p.fours), mostSixes: top(p => p.sixes),
    };
  }

  function headToHead(entries, keyA, keyB) {
    const out = { played: 0, a: 0, b: 0, tied: 0, nr: 0, matches: [] };
    entries.forEach(({ match, state }) => {
      if (state.status !== 'complete' && state.status !== 'abandoned') return;
      const keys = state.config.teams.map(teamKey);
      const ia = keys.indexOf(keyA), ib = keys.indexOf(keyB);
      if (ia < 0 || ib < 0) return;
      out.played++; out.matches.push(match.id);
      if (state.status === 'abandoned') out.nr++;
      else if (state.result.winner === ia) out.a++;
      else if (state.result.winner === ib) out.b++;
      else out.tied++;
    });
    return out;
  }

  return {
    DISMISSALS, BOWLER_CREDIT, WICKETS_ON, NON_STRIKER_OUT, FREE_HIT_OK, CONTROL_EVENTS,
    ScoringError, uid, createMatch, normalizeConfig, replay, undo, resetCurrentInnings, describeEvent,
    availableBatters, bowlerBlock, recentDeliveries, chase, awards, summarize, playersOf,
    oversStr, oversShort, rate, strikeRate, extrasTotal, extrasLine, scoreLine, inningsTitle,
    scorecardText, shareText, toCSV, buildStats, headToHead, teamKey,
  };
});
