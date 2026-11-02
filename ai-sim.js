#!/usr/bin/env node
// ============================================
// SHOOOTER 2D - AI simulation
// ============================================
// Runs the REAL game (game.js + ai.js) headless in Node and lets two computer players
// play against each other, so the numbers say something about the AI people actually
// play against. Player 1 and Player 2 can use different difficulties.
//
//   node ai-sim.js                         # difficulty ladder in every mode (Easy vs Medium, Medium vs Hard, Easy vs Hard)
//   node ai-sim.js --mode classic --games 100 --p1 easy --p2 hard
//   node ai-sim.js --mode lava --games 30 --p1 hard --p2 hard
//   node ai-sim.js --mode koth --map koth_summit --ammo infinite
//
// Options:
//   --mode    classic | oneshot | koth | tag | lava | all   (default all)
//   --games   games per matchup (default 40; sides are swapped every other game)
//   --p1/--p2 easy | medium | hard (sets a fixed matchup instead of the ladder)
//   --map     classic | towers | pyramid | chaos (duel modes; default: rotate)
//   --ammo    limited | infinite (default: the game's default, limited)
//   --frames  max frames per game (default 10800 = 3 minutes)
//   --seed    seed for Math.random (repeatable runs)
//   --quiet   only print the summary lines

const path = require('path');
const { loadGame } = require(path.join(__dirname, 'tools', 'headless.js'));

// --- arguments ---
const args = {};
for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
        const k = a.slice(2);
        const v = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
        args[k] = v;
    }
}
const MODES = { classic: 0, oneshot: 1, koth: 2, tag: 3, lava: 4 };
const DIFFS = { easy: 0, medium: 1, hard: 2 };
const DIFF_NAMES = ['Easy', 'Medium', 'Hard'];
const modeArg = (args.mode || 'all').toLowerCase();
const games = parseInt(args.games || '40', 10);
const maxFrames = parseInt(args.frames || '10800', 10);
const quiet = !!args.quiet;

if (args.seed) {
    // small seeded PRNG (mulberry32) for repeatable runs
    let t = parseInt(args.seed, 10) >>> 0;
    Math.random = function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const G = loadGame();
const FRAME_MS = 1000 / 60;

function playGame(mode, d1, d2, opts) {
    const S = G.settings;
    S.gameMode = mode;
    S.mode = 1;             // Player vs AI (player 2 gets a controller in createPlayers)
    S.aiDiff = d2;
    S.bestOf = 0;
    if (opts.ammo) S.infiniteAmmo = opts.ammo === 'infinite' ? 0 : 1;
    G.gameMode = 'pve';
    const maps = G.getAvailableMaps();
    const mapKey = opts.map && maps.includes(opts.map) ? opts.map : maps[opts.gameIndex % maps.length];
    S.map = maps.indexOf(mapKey);
    if (mode !== 4) G.platforms = G.MAPS[mapKey].platforms;
    G.roundWins = { p1: 0, p2: 0 };
    G.resetGame();
    G.countdownTimer = 0;
    // Player 1 becomes a computer player too
    G.player1.ai = new G.AIController(G.player1, G.player2, { difficulty: d1, swapKey: 'KeyE' });

    let frames = 0;
    let maxHeight = 0;
    while (frames < maxFrames) {
        const state = G.gameState;
        if (state === 'playing') {
            G.updatePlaying();
        } else if (state === 'dying') {
            G.updateDeathAnimation();
        } else {
            break;
        }
        if (mode === 4) maxHeight = Math.max(maxHeight, 500 - G.lavaState.lavaY);
        G.clock.advance(FRAME_MS);
        frames++;
    }
    let winner = 0; // 0 = draw / timeout
    if (G.gameState === 'gameover' || G.gameState === 'dying') {
        winner = G.winner === G.player1 ? 1 : G.winner === G.player2 ? 2 : 0;
    }
    if (winner === 0) {
        // timeout: decide by the mode's own score
        if (mode === 0 || mode === 1) winner = G.player1.hp > G.player2.hp ? 1 : G.player1.hp < G.player2.hp ? 2 : 0;
        if (mode === 2) winner = G.kothState.p1Score > G.kothState.p2Score ? 1 : G.kothState.p1Score < G.kothState.p2Score ? 2 : 0;
        if (mode === 3) winner = G.tagState.tagger === G.player1 ? 2 : 1;
        if (mode === 4) winner = G.lavaState.p1Lives > G.lavaState.p2Lives ? 1 : G.lavaState.p1Lives < G.lavaState.p2Lives ? 2 : 0;
    }
    const st = G.stats;
    return {
        winner, frames, mapKey,
        p1: { shots: st.p1.shotsFired, hits: st.p1.hits, deaths: st.p1.deaths, hp: G.player1.hp, dmg: st.p1.damageDone },
        p2: { shots: st.p2.shotsFired, hits: st.p2.hits, deaths: st.p2.deaths, hp: G.player2.hp, dmg: st.p2.damageDone },
        koth: mode === 2 ? [G.kothState.p1Score, G.kothState.p2Score] : null,
        tag: mode === 3 ? [G.tagState.p1Time, G.tagState.p2Time] : null,
        height: mode === 4 ? maxHeight : null,
    };
}

function runMatchup(mode, dA, dB, n, opts) {
    // dA plays both sides alternately so spawn side does not matter
    let winsA = 0, winsB = 0, draws = 0, frames = 0;
    const acc = { A: { shots: 0, hits: 0, deaths: 0 }, B: { shots: 0, hits: 0, deaths: 0 } };
    let height = 0;
    for (let g = 0; g < n; g++) {
        const swap = g % 2 === 1;
        const r = playGame(mode, swap ? dB : dA, swap ? dA : dB, Object.assign({ gameIndex: g }, opts));
        const a = swap ? r.p2 : r.p1, b = swap ? r.p1 : r.p2;
        const w = r.winner === 0 ? 0 : ((r.winner === 1) !== swap ? 'A' : 'B');
        if (w === 'A') winsA++; else if (w === 'B') winsB++; else draws++;
        frames += r.frames;
        for (const k of ['shots', 'hits', 'deaths']) { acc.A[k] += a[k]; acc.B[k] += b[k]; }
        if (r.height !== null) height += r.height;
        if (!quiet && args.verbose) console.log(`    game ${g + 1}: ${w === 'A' ? DIFF_NAMES[dA] : w === 'B' ? DIFF_NAMES[dB] : 'draw'} in ${(r.frames / 60).toFixed(0)}s on ${r.mapKey}`);
    }
    const acc1 = acc.A.shots ? (100 * acc.A.hits / acc.A.shots).toFixed(0) : '-';
    const acc2 = acc.B.shots ? (100 * acc.B.hits / acc.B.shots).toFixed(0) : '-';
    const extra = mode === 4 ? `, avg height ${(height / n / 8).toFixed(0)}m` : '';
    console.log(`  ${DIFF_NAMES[dA].padEnd(6)} vs ${DIFF_NAMES[dB].padEnd(6)}: ${String(winsA).padStart(3)} - ${String(winsB).padStart(3)}` +
        (draws ? ` (${draws} draws)` : '') +
        `  | avg ${(frames / n / 60).toFixed(0)}s, accuracy ${acc1}% / ${acc2}%, deaths ${acc.A.deaths}/${acc.B.deaths}${extra}`);
    return { winsA, winsB, draws };
}

const modeList = modeArg === 'all' ? Object.keys(MODES) : modeArg.split(',');
const opts = { map: args.map, ammo: args.ammo };
console.log(`=== SHOOOTER 2D AI simulation (${games} games per matchup, real game physics) ===`);
for (const m of modeList) {
    const mode = MODES[m];
    if (mode === undefined) { console.log('unknown mode', m); continue; }
    console.log(`\n--- ${G.GAME_MODE_OPTIONS[mode].name} ---`);
    const t0 = Date.now.call(null);
    const real0 = process.hrtime.bigint();
    if (args.p1 || args.p2) {
        runMatchup(mode, DIFFS[(args.p1 || 'medium').toLowerCase()], DIFFS[(args.p2 || 'medium').toLowerCase()], games, opts);
    } else {
        runMatchup(mode, 0, 1, games, opts);
        runMatchup(mode, 1, 2, games, opts);
        runMatchup(mode, 0, 2, games, opts);
    }
    const secs = Number(process.hrtime.bigint() - real0) / 1e9;
    if (!quiet) console.log(`  (${secs.toFixed(1)}s wall time)`);
}
