// ============================================
// Headless loader: runs the real game.js in Node without a browser
// ============================================
// Used by ai-sim.js. Stubs out canvas / DOM / localStorage, loads ai.js and
// game.js into the current context and returns accessors for the game's
// top-level variables, plus a virtual clock so Date.now() advances per frame.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeCtxStub() {
    const noop = () => {};
    return new Proxy({}, {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 });
            if (prop === 'createLinearGradient') return () => ({ addColorStop: noop });
            if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
            return noop;
        },
        set(target, prop, value) { target[prop] = value; return true; },
    });
}

function makeCanvasStub(width, height) {
    const ctx = makeCtxStub();
    return {
        width, height,
        getContext: () => ctx,
        addEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
        style: {},
    };
}

function loadGame(opts = {}) {
    const root = opts.root || path.join(__dirname, '..');
    const mainCanvas = makeCanvasStub(800, 500);

    // --- Virtual clock ---
    let simNow = 1_000_000;
    const realDateNow = Date.now;
    Date.now = () => simNow;
    const clock = {
        advance(ms) { simNow += ms; },
        now() { return simNow; },
        restore() { Date.now = realDateNow; },
    };

    // --- DOM / browser stubs ---
    const storage = {};
    global.window = global;
    global.document = {
        getElementById: () => mainCanvas,
        createElement: () => makeCanvasStub(800, 500),
        addEventListener: () => {},
    };
    global.localStorage = {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; },
    };
    global.requestAnimationFrame = () => 0;
    global.addEventListener = () => {};

    // --- Load the scripts into this context (shared global lexical scope) ---
    const files = opts.files || ['ai.js', 'game.js'];
    for (const f of files) {
        const src = fs.readFileSync(path.isAbsolute(f) ? f : path.join(root, f), 'utf8');
        vm.runInThisContext(src, { filename: f });
    }

    // --- Accessors for the game's top-level let/const variables ---
    const names = opts.names || [
        'settings', 'gameState', 'gameMode', 'winner', 'loser', 'player1', 'player2', 'platforms', 'MAPS',
        'roundWins', 'stats', 'lavaState', 'kothState', 'tagState', 'countdownTimer', 'keys', 'powerups',
        'ammoPickups', 'frameCount', 'gamePaused', 'AI_DIFF_OPTIONS', 'HP_OPTIONS', 'GAME_MODE_OPTIONS',
    ];
    const funcs = opts.funcs || ['resetGame', 'updatePlaying', 'updateDeathAnimation', 'getAvailableMaps', 'AIController', 'AI_PROFILES'];
    const body = names.map(n => `get ${n}() { return typeof ${n} === 'undefined' ? undefined : ${n}; }, set ${n}(v) { ${n} = v; }`)
        .concat(funcs.map(n => `get ${n}() { return typeof ${n} === 'undefined' ? undefined : ${n}; }`))
        .join(',\n');
    const G = vm.runInThisContext('({' + body + '})');
    G.clock = clock;
    G.eval = (code) => vm.runInThisContext(code);
    return G;
}

module.exports = { loadGame };
