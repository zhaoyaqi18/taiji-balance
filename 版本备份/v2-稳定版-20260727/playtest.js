// Headless playtest harness for TAIJI BALANCE.
// Loads the game's <script> as-is, stubs browser APIs, and simulates real play.
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf-8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

/* ---------- browser stubs ---------- */
const gradientStub = { addColorStop() {} };
function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return {};
      return (...a) => {
        if (typeof k === 'string' && k.startsWith('create')) return gradientStub;
        return undefined;
      };
    },
    set() { return true; }
  });
}
function makeEl(id) {
  const el = {
    id, _h: {}, textContent: '', offsetWidth: 0,
    style: new Proxy({}, { get: () => () => {}, set: () => true }),
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener(ev, fn) { (el._h[ev] = el._h[ev] || []).push(fn); },
    children: []
  };
  return el;
}
const els = {};
const livesKids = [makeEl('l0'), makeEl('l1'), makeEl('l2')];
const cvEl = makeEl('cv');
cvEl.getContext = () => makeCtx();
cvEl.width = 0; cvEl.height = 0;

const winHandlers = {};
let rafCb = null;
let storeMem = {};

const sandbox = {
  console,
  performance: { now: () => Date.now() },
  requestAnimationFrame: cb => { rafCb = cb; },
  localStorage: {
    getItem: k => (k in storeMem ? storeMem[k] : null),
    setItem: (k, v) => { storeMem[k] = String(v); },
    removeItem: k => { delete storeMem[k]; }
  },
  navigator: { vibrate: () => {} },
  document: {
    getElementById: id => {
      if (id === 'cv') return cvEl;
      if (!els[id]) els[id] = makeEl(id);
      if (id === 'lives') els[id].children = livesKids;
      return els[id];
    },
    createElement: tag => {
      const c = makeEl(tag);
      c.getContext = () => makeCtx();
      c.width = 0; c.height = 0;
      return c;
    },
    addEventListener(ev, fn) { (winHandlers['doc:' + ev] = winHandlers['doc:' + ev] || []).push(fn); },
    documentElement: makeEl('html'),
    hidden: false
  },
  window: null,
  setTimeout: (fn) => 0, clearTimeout: () => {},
  matchMedia: () => ({ matches: false })
};
sandbox.window = sandbox;
sandbox.window.innerWidth = 1280;
sandbox.window.innerHeight = 800;
sandbox.window.devicePixelRatio = 1;
sandbox.window.matchMedia = sandbox.matchMedia;
sandbox.window.addEventListener = (ev, fn) => { (winHandlers[ev] = winHandlers[ev] || []).push(fn); };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ---------- load game ---------- */
try {
  vm.runInContext(src, sandbox, { filename: 'game.js' });
} catch (e) {
  console.log('FATAL load error:', e.stack);
  process.exit(1);
}

/* ---------- driver ---------- */
let simTs = 1000;
function pump(seconds, dtms = 16.7) {
  const steps = Math.round(seconds * 1000 / dtms);
  for (let i = 0; i < steps; i++) {
    simTs += dtms;
    const cb = rafCb;
    if (cb) cb(simTs);
  }
}
const results = [];
function check(name, cond, extra) {
  results.push([name, !!cond, extra || '']);
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
}
const G = code => vm.runInContext(code, sandbox);
// deterministic scenario reset: playing, alive, protected unless a test says otherwise
function ensurePlay() {
  if (G('state') !== G('ST.PLAY')) { G('startGame()'); pump(2.3); }
  G('orbs = []; queue = []; lives = 3; invT = 999; taijiT = 0; hitstop = 0; input.has = false; canPerfect = false; salvaged = false; chi = 0; combo = 0;');
}

try {
  // 1. boot & title screen frames
  pump(1);
  check('boot renders without exception', true);
  check('starts at TITLE', G('state') === G('ST.TITLE'));

  // 2. start game -> countdown -> play
  G('startGame()');
  check('startGame enters CD', G('state') === G('ST.CD'));
  pump(2.3);
  check('countdown reaches PLAY', G('state') === G('ST.PLAY'));

  // 3. mouse follow movement
  G('input.tx = 1000; input.ty = 200; input.has = true;');
  const px0 = G('player.x'), py0 = G('player.y');
  pump(1.0);
  const px1 = G('player.x'), py1 = G('player.y');
  check('ball moves toward pointer', px1 > px0 && py1 < py0, `(${px0|0},${py0|0}) -> (${px1|0},${py1|0})`);

  // 4. ambient spawn over time
  G('input.has = false;');
  pump(6);
  check('orbs spawn during play', G('orbs.length') > 0, 'orbs=' + G('orbs.length'));

  // 5. absorb same-phase orb -> score & chi
  ensurePlay();
  G('player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 1);');
  const s0 = G('score'), c0 = G('chi');
  pump(0.1);
  check('absorb scores +100', G('score') - s0 === 100, 'score delta=' + (G('score') - s0));
  check('absorb gains chi', G('chi') > c0, 'chi=' + G('chi'));

  // 6. opposite phase hurts: lose life, chi/combo reset
  ensurePlay();
  G('player.phase = 1; chi = 5; combo = 4; invT = 0; spawnOrb(player.x, player.y, 0, 0, 0);');
  pump(0.1);
  check('opposite orb costs a life', G('lives') === 2, 'lives=' + G('lives'));
  check('hurt resets chi & combo', G('chi') === 0 && G('combo') === 0);

  // 7. tap-to-taiji via real pointer events
  ensurePlay();
  G('chi = 8;');
  const pd = cvEl._h['pointerdown'][0];
  const pu = winHandlers['pointerup'][0];
  pd({ pointerId: 7, clientX: G('player.x'), clientY: G('player.y'), pointerType: 'touch' });
  pu({ pointerId: 7, pointerType: 'touch' });
  check('tap triggers TAIJI when chi>=8', G('taijiT') > 0, 'taijiT=' + G('taijiT'));
  check('taiji consumes chi', G('chi') === 0);

  // 8. taiji time tiers: 16 -> 1.6s, 24 -> 2.4s
  ensurePlay();
  G('chi = 16; startTaiji();');
  check('16 sparks -> 1.6s taiji', Math.abs(G('taijiT') - 1.6) < 0.01, 'taijiT=' + G('taijiT'));
  G('chi = 24; startTaiji();');
  check('24 sparks -> 2.4s taiji', Math.abs(G('taijiT') - 2.4) < 0.01, 'taijiT=' + G('taijiT'));

  // 9. phase flips on its own timer
  ensurePlay();
  const ph0 = G('player.phase');
  G('phaseT = 0.01;');
  pump(0.2);
  check('yin-yang flips automatically', G('player.phase') !== ph0);

  // 10. milestone seal + bonus score
  ensurePlay();
  G('t = 29.9; mileIdx = 0; score = 0;');
  pump(0.3);
  check('30s milestone fires (seal + bonus)', G('mileIdx') === 1 && G('score') >= 500, 'score=' + G('score'));
  check('seal element shown', els['seal'] && els['seal'].classList.contains('show'));

  // 11. new orb types appear late-game
  G('t = 100;');
  let types = new Set();
  for (let i = 0; i < 40; i++) types.add(G('pickType()'));
  check('waver appears after 90s', types.has('waver'), [...types].join(','));
  G('t = 220;');
  types = new Set();
  for (let i = 0; i < 60; i++) types.add(G('pickType()'));
  check('split & dual appear after 180/210s', types.has('split') && types.has('dual'), [...types].join(','));

  // 12. splitter splits on absorb
  ensurePlay();
  G('player.phase = 1; spawnOrb(player.x, player.y, 10, 0, 1, undefined, "split");');
  pump(0.1);
  const kids = G('orbs.filter(o => o.small).length');
  check('splitter splits into 2 children', kids === 2, 'children=' + kids);
  check('children are flagged small (no re-split)', G('orbs.filter(o => o.small).every(o => o.type === "norm")'));

  // 13. dual-phase orb flips itself
  ensurePlay();
  G('spawnOrb(cx, cy, 5, 0, 1, undefined, "dual"); orbs[0].flipT = 0.01;');
  pump(0.2);
  check('dual orb flips its own color', G('orbs.length ? orbs[0].phase : -1') === 0);

  // 14. tide after 300s
  ensurePlay();
  G('t = 305; director.tideAt = 305;');
  pump(1.0);
  check('yin-yang tide spawns after 300s', G('seenTide') === true);

  // 15. flip interval tightens late
  G('t = 320;');
  let maxInt = 0;
  for (let i = 0; i < 30; i++) maxInt = Math.max(maxInt, G('nextPhaseInt()'));
  check('flip interval <=4s after 300s', maxInt <= 4, 'max=' + maxInt.toFixed(2));

  // 15b. 无极境：逍遥印章 + 循环印章 + 场地收缩 + 加压曲线 + 无常翻转
  ensurePlay();
  G('t = 599.9; mileIdx = 11; score = 0;');
  pump(0.3);
  check('600s seal is 逍遥 (+20000)', G('mileIdx') === 12 && G('score') >= 20000 && els['sealChar'].textContent === '逍遥', 'score=' + G('score'));
  G('t = 659.9; score = 0;');
  pump(0.3);
  check('recurring 逍遥 seal after 600s (+6000)', G('mileIdx') === 13 && G('score') >= 6000 && /FREE ×1/.test(els['sealEn'].textContent), els['sealEn'].textContent);
  G('t = 360;');
  pump(0.2);
  check('arena shrinks after 300s', G('arenaK') < 1 && G('R') < G('baseR'), 'arenaK=' + G('arenaK').toFixed(3));
  G('t = 800;');
  pump(0.2);
  check('arena shrink bottoms at 75%', G('arenaK') === 0.75, 'arenaK=' + G('arenaK'));
  G('t = 500;');
  maxInt = 0;
  for (let i = 0; i < 40; i++) maxInt = Math.max(maxInt, G('nextPhaseInt()'));
  check('flip interval <=3s in endgame', maxInt <= 3, 'max=' + maxInt.toFixed(2));
  let silentCount = 0;
  for (let i = 0; i < 200; i++) { G('flipPhase()'); if (G('silentFlip')) silentCount++; }
  check('silent flips exist but stay rare (~15%)', silentCount > 0 && silentCount < 80, 'silent=' + silentCount + '/200');
  G('t = 500; director.tideAt = 500;');
  pump(0.3);
  const tideGap = G('director.tideAt') - G('t');
  check('tide interval tightens in endgame', tideGap > 0 && tideGap <= 21, 'gap=' + tideGap.toFixed(1) + 's');

  // 15c. 成瘾机制：完美接应 / 炁溢转分 / 以炁换命 / 残血暴走 / 惜败提示
  ensurePlay();
  G('score = 0; flipPhase();');   // 触发翻转，开启完美接应窗口
  G('spawnOrb(player.x, player.y, 0, 0, player.phase);');
  pump(0.1);
  check('perfect flip scores ×3', G('score') === 300, 'score=' + G('score'));
  ensurePlay();
  G('score = 0; flipPhase();');
  pump(1.0);   // 窗口期(0.8s)过后再吸 → 无暴击
  G('spawnOrb(player.x, player.y, 0, 0, player.phase);');
  pump(0.1);
  check('perfect window expires', G('score') === 100, 'score=' + G('score'));
  ensurePlay();
  G('score = 0; chi = 24; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 1);');
  pump(0.1);
  check('chi overflow converts to +200', G('score') === 300, 'score=' + G('score'));
  ensurePlay();
  G('lives = 1; chi = 12; invT = 0; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 0);');
  pump(0.1);
  check('chi salvation negates death', G('lives') === 1 && G('chi') === 0 && G('salvaged') === true && G('state') === G('ST.PLAY'), 'lives=' + G('lives') + ' chi=' + G('chi'));
  ensurePlay();
  G('salvaged = true; lives = 1; chi = 12; invT = 0; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 0);');
  pump(0.1);
  check('salvation only once per game', G('lives') === 0, 'lives=' + G('lives'));
  ensurePlay();
  G('score = 0; lives = 1; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 1);');
  pump(0.1);
  check('last-stand scores ×1.5', G('score') === 150, 'score=' + G('score'));
  ensurePlay();
  G('t = 57; lives = 1; invT = 0; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 0);');
  pump(1.2);
  check('near-miss hook shown at game over', G('state') === G('ST.OVER') && /守中/.test(els['overNear'].textContent), els['overNear'].textContent);

  // 16. graze scores +50 without damage
  ensurePlay();
  G('window.__toastLog = []; seenGraze = false; const __origST = showToast; showToast = (x, d) => { __toastLog.push(x); __origST(x, d); };');
  G('player.phase = 1; player.vx = 0; player.vy = 0; const rr = player.r + clamp(R*0.042,8,14); spawnOrb(player.x + rr + 8, player.y, 0, 0, 0);');
  const g0 = G('grazes'), sc0 = G('score');
  pump(0.1);
  check('graze scores +50', G('score') - sc0 === 50 && G('grazes') - g0 === 1 && G('lives') === 3, 'delta score=' + (G('score') - sc0) + ' grazes=' + (G('grazes') - g0));
  check('first graze shows teaching toast', G('__toastLog.some(s => /Close shave/.test(s))'));

  // 17. boundary touch costs a life (fell out of taiji)
  ensurePlay();
  G('invT = 0; player.x = cx + R - player.r + 2; player.y = cy; player.vx = R; player.vy = 0;');
  pump(0.1);
  check('touching boundary costs a life', G('lives') === 2 && G('deathCause') === 'void', 'lives=' + G('lives'));

  // 18. death -> game over screen with quote & score
  ensurePlay();
  G('score = 1234; lives = 1; invT = 0; player.phase = 1; spawnOrb(player.x, player.y, 0, 0, 0);');
  pump(0.2);
  check('last life enters DYING', G('state') === G('ST.DYING'));
  pump(1.0);
  check('reaches OVER screen', G('state') === G('ST.OVER'));
  const qe = els['overQuoteEn'].textContent, qc = els['overQuoteCn'].textContent;
  check('philosophy quote shown (EN+CN)', qe.length > 10 && qc.length > 3, qe.slice(0, 40));
  check('final score displayed', /SCORE 1,234/.test(els['overScore'].textContent), els['overScore'].textContent);
  check('best records persisted', G('best') > 0 && G('bestScore') === 1234, 'best=' + G('best').toFixed(1) + ' bestScore=' + G('bestScore'));

  // 19. restart from over -> clean state
  G('startGame()');
  check('restart resets score/lives/chi', G('score') === 0 && G('lives') === 3 && G('chi') === 0);
  pump(2.3);
  check('restart reaches PLAY again', G('state') === G('ST.PLAY'));

  // 20. pause / resume flow
  G('pauseGame();');
  check('pause works', G('state') === G('ST.PAUSE'));
  G('resumeGame();');
  check('resume works', G('state') === G('ST.PLAY'));

  // 20b. tab hidden during countdown also pauses, resumes back into CD
  G('startGame();');
  const visH = winHandlers['doc:visibilitychange'][0];
  sandbox.document.hidden = true;
  visH();
  sandbox.document.hidden = false;
  check('hidden during CD pauses', G('state') === G('ST.PAUSE'));
  G('resumeGame();');
  check('resume returns to countdown', G('state') === G('ST.CD'));
  pump(2.3);
  check('countdown finishes after resume', G('state') === G('ST.PLAY'));

  // 21. share button always gives feedback (fallback chain never silently fails)
  G('state = ST.OVER; shareTxt = "☯ TAIJI BALANCE — test share";');
  els['toast'].textContent = '';
  let shareErr = null;
  G('shareScore()').catch(e => { shareErr = e; });
  setTimeout(() => {
    check('shareScore never throws', shareErr === null);
    check('share falls back to showing text', /TAIJI BALANCE/.test(els['toast'].textContent) || els['shareBtn'].textContent === 'COPIED', els['toast'].textContent.slice(0, 30) || els['shareBtn'].textContent);

    // 22. 5-minute soak at high difficulty: no exceptions, caps hold
    try {
      G('startGame(); pump = 0;');
      pump(2.3);
      G('t = 240;');
      pump(300, 50);
      check('5-min soak survives', G('orbs.length') <= 53 && G('parts.length') <= 241, 'orbs=' + G('orbs.length') + ' parts=' + G('parts.length'));
      check('game still in a valid state', [G('ST.PLAY'), G('ST.DYING'), G('ST.OVER')].includes(G('state')), 'state=' + G('state'));
    } catch (e) {
      console.log('FATAL runtime error:', e.stack);
    }

    const fails = results.filter(r => !r[1]).length;
    console.log('\n==== ' + (results.length - fails) + '/' + results.length + ' passed, ' + fails + ' failed ====');
    process.exit(fails ? 1 : 0);
  }, 30);

} catch (e) {
  console.log('FATAL runtime error:', e.stack);
  process.exit(1);
}
