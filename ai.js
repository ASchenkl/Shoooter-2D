// ============================================
// SHOOOTER 2D - AI OPPONENT
// ============================================
// Loaded before game.js. Everything the computer player does lives in this file.
//
// Layers (top to bottom):
//   1. AI_PROFILES  - the three difficulty levels as a handful of plain numbers
//   2. Physics      - jump / fall simulation that mirrors Player.update() frame by frame
//   3. AINav        - platforms are nodes, simulated jumps and drops are edges, Dijkstra plans routes
//   4. AIController - one per computer player: sense -> think (per game mode) -> steer -> aim/dodge -> press keys
//   5. Brains       - thinkDuel (Classic / One Shot), thinkKoth, thinkTag, updateLava
//
// The controller only ever presses keys (it writes into `keys`), so it plays by the same rules
// as a human: facing follows movement, shots have a cooldown, ammo can run out, inverted
// controls invert it too. Difficulty comes from reaction time, aim error, dodge skill and
// planning depth - never from extra speed or extra information.
//
// Reads game.js globals: platforms, settings, keys, powerups, ammoPickups, lavaState, kothState,
// tagState, GRAVITY_OPTIONS, PLAYER_SPEED, JUMP_FORCE, BULLET_SPEED, POWERUP_TYPES, HP_OPTIONS.

// ============================================
// 1. DIFFICULTY PROFILES
// ============================================
const AI_PROFILES = [
    {
        name: 'Easy',
        reaction: 16,          // frames between decisions and perception lag (16 = ~270 ms)
        aimError: 26,          // vertical aiming error in px (standard deviation)
        aimHold: 30,           // frames an aiming error persists before it is re-rolled
        predictAim: false,     // lead airborne targets
        seesShield: false,     // stops shooting at a shielded enemy
        dodgeSkill: 0.2,       // chance to react to a bullet at all
        dodgeWindow: 14,       // dodge when the bullet is this many frames away (or closer)
        hesitation: 0.3,       // chance per decision to keep doing the old thing
        planDepth: 2,          // jumps planned ahead
        edgeMargin: 16,        // px of overlap kept at platform edges when jumping (bigger = safer, fewer routes)
        lavaMargin: 22,        // same for Lava Rise, where a miss is deadly
        climbSkill: 0.5,       // Lava Rise: 1 = always picks the best platform
        shotCooldown: 600,     // ms between shots (human: 300)
        stopAndShoot: false,   // can stop for one frame to fire while retreating
        hopOver: false,        // jumps over an enemy when cornered
        itemIQ: 0,             // 0..1 how well swap / double jump / platform charges are used
        pickupIQ: 0.4,         // 0..1 how well power-ups are valued (0 = grabs whatever is close)
        invertAdapt: Infinity, // ms until it compensates inverted controls
        rangeBand: [70, 200],  // preferred horizontal shooting distance
        ammoReserve: 1,        // starts looking for ammo at this count
    },
    {
        name: 'Medium',
        reaction: 7,
        aimError: 10,
        aimHold: 18,
        predictAim: false,
        seesShield: true,
        dodgeSkill: 0.5,
        dodgeWindow: 11,
        hesitation: 0.1,
        planDepth: 4,
        edgeMargin: 13,
        lavaMargin: 16,
        climbSkill: 0.75,
        shotCooldown: 450,
        stopAndShoot: true,
        hopOver: true,
        itemIQ: 0.6,
        pickupIQ: 0.8,
        invertAdapt: 2500,
        rangeBand: [120, 280],
        ammoReserve: 3,
    },
    {
        name: 'Hard',
        reaction: 3,
        aimError: 4,
        aimHold: 10,
        predictAim: true,
        seesShield: true,
        dodgeSkill: 0.9,
        dodgeWindow: 9,
        hesitation: 0,
        planDepth: 5,
        edgeMargin: 12,
        lavaMargin: 12,
        climbSkill: 1,
        shotCooldown: 300,
        stopAndShoot: true,
        hopOver: true,
        itemIQ: 1,
        pickupIQ: 1,
        invertAdapt: 500,
        rangeBand: [160, 340],
        ammoReserve: 4,
    },
];

// ============================================
// 2. PHYSICS (mirrors Player.update / Player.shoot)
// ============================================
const AI_W = 800, AI_H = 500;
const AI_PW = 32, AI_PH = 40;              // player hitbox
const AI_BULLET_DY = 18, AI_BULLET_H = 8;  // bullet spawns at player.y + 18, 8 px tall
const AI_BULLET_LIFE = 80;                 // frames
const AI_MAX_DROP = 260;                   // ignore routes that drop further than this
const AI_LAVA = {
    SCREEN_MARGIN: 6,   // Lava Rise: min px between head at jump apex and screen top
    GOAL_LINE: 250,     // Lava Rise: feet above this screen Y = upper half of the screen
    REPLAN_FRAMES: 20,  // Lava Rise: re-plan this often while standing still
    MAX_DROP: 260,      // Lava Rise: ignore jumps that drop further than this
};

const aiClamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const aiCX = (p) => p.x + p.w / 2;

function aiGauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Can a shooter whose top edge is at sy hit a target whose top edge is at ty?
// Bullets fly horizontally at [sy+18, sy+26]; the target spans [ty, ty+40]  =>  ty - sy in (-22, 26)
function aiCanHitY(sy, ty, margin) {
    const d = ty - sy;
    const m = margin || 0;
    return d > -(AI_PH - AI_BULLET_DY) + m && d < (AI_BULLET_DY + AI_BULLET_H) - m;
}

// Rise height of a jump that starts with vertical speed vy (negative = up)
function aiRiseHeight(vy, g) {
    let h = 0;
    while (vy < 0) {
        vy += g;
        if (vy < 0) h -= vy;
    }
    return h;
}

// Jump / run numbers for this player right now (power-ups and gravity setting included)
function aiPhysics(player) {
    const g = GRAVITY_OPTIONS[settings.gravity].value;
    const gravRoot = Math.sqrt(g / 0.6);
    const sj = player.hasPowerup('superjump') ? 1.35 : 1;
    let speed = PLAYER_SPEED;
    if (player.hasPowerup('speedboost')) speed *= 1.5;
    const jumpVy = JUMP_FORCE * gravRoot * sj;
    const bounceVy = JUMP_FORCE * gravRoot * 1.6;
    const djVy = jumpVy * 1.1;
    return {
        g, speed, jumpVy, bounceVy, djVy,
        jumpH: aiRiseHeight(jumpVy, g),
        bounceH: aiRiseHeight(bounceVy, g),
        djH: aiRiseHeight(djVy, g),
        key: speed.toFixed(2) + '/' + jumpVy.toFixed(2),
    };
}

const aiIsMoving = (p) => !!(p.moving || p.carousel);

// Predicted position of a (moving) platform `ahead` frames from now
function aiPlatAt(p, ahead) {
    if (p.moving) {
        const m = p.moving;
        const s = Math.sin((lavaState.framesSinceStart + ahead) * m.speed + m.phase) * m.range;
        return m.axis === 'h' ? { x: m.originX + s, y: p.y } : { x: p.x, y: m.originY + s };
    }
    if (p.carousel) {
        const c = p.carousel;
        const t = lavaState.framesSinceStart + ahead;
        const masterAngle = t * c.masterSpeed + c.masterPhase;
        const subAngle = t * c.subSpeed + c.subPhase;
        return {
            x: c.masterCenterX + Math.cos(masterAngle) * c.masterRadius + Math.cos(subAngle) * c.subRadius - p.w / 2,
            y: c.masterCenterY + Math.sin(masterAngle) * c.masterRadius + Math.sin(subAngle) * c.subRadius,
        };
    }
    return p;
}

// Simulate a flight from (cx0, feet0) with vertical speed vy0, steering toward xL every frame
// exactly like the controller does. Returns the first platform landed on, or null.
function aiSimFlight(cx0, feet0, vy0, xL, phys, cands, t0, opts) {
    const ignore = opts && opts.ignore;
    const deathY = opts && opts.deathY !== undefined ? opts.deathY : Infinity;
    const maxT = (opts && opts.maxFrames) || 180;
    let x = cx0, feet = feet0, vy = vy0;
    for (let t = 1; t <= maxT; t++) {
        vy += phys.g;
        const dx = xL - x;
        x += Math.abs(dx) <= phys.speed ? dx : Math.sign(dx) * phys.speed;
        x = aiClamp(x, AI_PW / 2, AI_W - AI_PW / 2);
        feet += vy;
        if (vy >= 0) {
            for (const p of cands) {
                if (p === ignore) continue;
                const pos = aiIsMoving(p) ? aiPlatAt(p, t0 + t) : p;
                if (x + AI_PW / 2 > pos.x && x - AI_PW / 2 < pos.x + p.w &&
                    feet > pos.y && feet < pos.y + p.h + vy + 2) {
                    return { plat: p, frames: t, x, landX: pos.x };
                }
            }
            if (feet > deathY) return null;
        }
    }
    return null;
}

// Frames until we come down onto platform p (following it if it moves), or -1
function aiLandFrames(vy, feet, p, g) {
    for (let t = 1; t <= 180; t++) {
        vy += g;
        feet += vy;
        if (vy >= 0) {
            const py = aiIsMoving(p) ? aiPlatAt(p, t).y : p.y;
            if (feet > py && feet < py + p.h + vy + 2) return t;
            if (feet > py + p.h + vy + 2 && !aiIsMoving(p)) return -1;
        }
    }
    return -1;
}

// Frames until a flight with start speed vy0 comes (back) down through dy (negative = higher than start)
function aiFlightFrames(vy0, dy, g) {
    let y = 0, vy = vy0;
    for (let t = 1; t <= 180; t++) {
        vy += g;
        y += vy;
        if (vy >= 0 && y >= dy) return t;
    }
    return -1;
}

// Where will a player be `t` frames from now if it keeps falling / jumping (lands on platforms)?
function aiPredictY(player, t, g) {
    if (player.onGround || t <= 0) return player.y;
    let y = player.y, vy = player.vy;
    const x = player.x;
    for (let i = 0; i < t; i++) {
        vy += g;
        y += vy;
        if (vy >= 0) {
            for (const p of platforms) {
                if (x + AI_PW > p.x && x < p.x + p.w && y + AI_PH > p.y && y + AI_PH < p.y + p.h + vy + 2) {
                    return p.y - AI_PH;
                }
            }
        }
    }
    return y;
}

// ============================================
// 3. NAVIGATION GRAPH
// ============================================
// Edges are found by simulating the real physics, so the bot only attempts jumps it can land.
// Static pairs of platforms are cached; moving platforms are always simulated live.
class AINav {
    constructor() {
        this.cache = new WeakMap(); // from -> Map(to -> { frame, key, options })
        this.failed = [];           // [{ from, to, frame }] edges that went wrong recently
    }

    // Standing range (player center x) on a platform, keeping `margin` px of overlap.
    // On ice the game drops you as soon as your center passes the edge, so the center must stay on it.
    static standRange(pos, w, margin, ice) {
        if (ice) {
            const m = Math.max(4, margin - 12);
            return [pos.x + m, pos.x + w - m];
        }
        return [pos.x - AI_PW / 2 + margin, pos.x + w + AI_PW / 2 - margin];
    }

    // Best way from `from` (standing at fromX, t0 frames from now) onto `to`, or null.
    // o: { phys, cands, margin, maxDrop, deathY, allowDrop, cacheTTL, frame }
    edge(from, fromX, t0, to, o) {
        if (from === to) return null;
        const live = aiIsMoving(from) || aiIsMoving(to) || from.bounce;
        if (live) return this._bestOption(this._computeOptions(from, fromX, t0, to, o, true), fromX, o.phys);
        // cached: options do not depend on fromX, only their walking cost does
        let m = this.cache.get(from);
        if (!m) { m = new Map(); this.cache.set(from, m); }
        const key = o.phys.key + '|' + o.margin + '|' + (o.allowDrop ? 1 : 0) + '|' + (settings.dropThrough);
        let entry = m.get(to);
        if (!entry || entry.key !== key || (o.frame - entry.frame) > (o.cacheTTL || Infinity)) {
            entry = { key, frame: o.frame, options: this._computeOptions(from, fromX, 0, to, o) };
            m.set(to, entry);
        }
        return this._bestOption(entry.options, fromX, o.phys);
    }

    _bestOption(options, fromX, phys) {
        let best = null, bestCost = Infinity;
        for (const op of options) {
            const walk = Math.abs(op.cx0 - fromX) / phys.speed;
            const cost = walk + op.flight;
            if (cost < bestCost) { bestCost = cost; best = op; }
        }
        if (!best) return null;
        return Object.assign({}, best, { frames: bestCost });
    }

    // Feasible take-off / landing combinations from `from` to `to` (jumps, and drops when `to` is lower).
    // With firstOnly, candidates are tried cheapest-first and the first working one is returned.
    _computeOptions(from, fromX, t0, to, o, firstOnly) {
        const options = [];
        const phys = o.phys, margin = o.margin;
        const fromPos = aiIsMoving(from) ? aiPlatAt(from, t0) : from;
        const toNow = aiIsMoving(to) ? aiPlatAt(to, t0 + 30) : to;
        const dy = toNow.y - fromPos.y;
        const maxDrop = o.maxDrop !== undefined ? o.maxDrop : AI_MAX_DROP;
        if (dy > maxDrop) return options;

        const [lo, hi] = AINav.standRange(fromPos, from.w, margin, from.ice);
        if (lo > hi) return options;
        const clampFrom = v => aiClamp(v, lo, hi);
        const toCX = toNow.x + to.w / 2;
        const simOpts = { deathY: o.deathY };

        const tryOption = (kind, cx0, vy0, ignore, maxFlight) => {
            if (firstOnly && options.length) return;
            const walk = Math.abs(cx0 - fromX);
            // where the target will be when we get there (moving platforms)
            const tl = aiIsMoving(to) ? aiPlatAt(to, t0 + walk / phys.speed + maxFlight) : to;
            const [llo, lhi] = AINav.standRange(tl, to.w, margin + 2, to.ice);
            if (llo > lhi) return;
            const landings = [aiClamp(cx0, llo, lhi), tl.x + to.w / 2, llo, lhi];
            const reach = phys.speed * maxFlight;
            const seen = new Set();
            for (const xL of landings) {
                const k = Math.round(xL);
                if (seen.has(k)) continue;
                seen.add(k);
                if (Math.abs(xL - cx0) > reach + 4) continue;
                const minX = Math.min(cx0, xL) - 24, maxX = Math.max(cx0, xL) + 24;
                const top = Math.min(fromPos.y, toNow.y) - (vy0 < 0 ? aiRiseHeight(vy0, phys.g) : 0) - 8;
                const cands = o.cands.filter(p => {
                    if (p === ignore) return false;
                    const slack = aiIsMoving(p) ? 260 : 0;
                    return p.y > top - slack && p.y < Math.max(fromPos.y, toNow.y) + 40 + slack &&
                        p.x + p.w > minX - slack && p.x < maxX + slack;
                });
                const tStart = t0 + walk / phys.speed;
                const fromY = aiIsMoving(from) ? aiPlatAt(from, tStart).y : fromPos.y;
                simOpts.ignore = ignore;
                const res = aiSimFlight(cx0, fromY, vy0, xL, phys, cands, tStart, simOpts);
                if (res && res.plat === to) {
                    options.push({
                        kind, from, to, cx0, xL, vy0,
                        landOffset: xL - res.landX, flight: res.frames, arriveX: res.x,
                        through: kind === 'drop' && !!ignore,
                    });
                    return; // one landing per take-off spot is enough
                }
            }
        };

        // --- Jumps (also used to jump down) ---
        const isBounce = !!from.bounce;
        const vy0 = isBounce ? phys.bounceVy : phys.jumpVy;
        const rise = isBounce ? phys.bounceH : phys.jumpH;
        if (dy >= -rise - to.h) {
            const flight = aiFlightFrames(vy0, dy, phys.g);
            if (flight > 0) {
                const takeoffs = isBounce ? [fromX] : [clampFrom(fromX), clampFrom(toCX), lo, hi];
                if (!isBounce && from.w > 200) takeoffs.push(clampFrom(toCX - 60), clampFrom(toCX + 60));
                if (firstOnly) takeoffs.sort((a, b) => Math.abs(a - fromX) - Math.abs(b - fromX));
                const seen = new Set();
                for (const cx0 of takeoffs) {
                    const k = Math.round(cx0);
                    if (seen.has(k)) continue;
                    seen.add(k);
                    tryOption('jump', cx0, vy0, null, flight);
                }
            }
        }

        // --- Drops (walk off an edge, or drop through the platform) ---
        if (o.allowDrop && dy > 8 && !isBounce) {
            const fall = aiFlightFrames(0, dy, phys.g);
            if (fall > 0) {
                // walk off the edge nearest to the target
                const offL = fromPos.x - AI_PW / 2 - 1, offR = fromPos.x + from.w + AI_PW / 2 + 1;
                const edges = toCX < fromPos.x + from.w / 2 ? [offL, offR] : [offR, offL];
                for (const cx0 of edges) tryOption('drop', cx0, 0, null, fall);
                // drop through (not from the ground); several spots so the nearest one can be used
                if (settings.dropThrough === 0 && !from.isGround) {
                    const fallT = aiFlightFrames(2, dy, phys.g);
                    if (fallT > 0) {
                        const spots = [clampFrom(fromX), clampFrom(toCX), clampFrom(fromPos.x + from.w / 2), lo, hi];
                        const seenT = new Set();
                        for (const cx0 of spots) {
                            const k = Math.round(cx0);
                            if (seenT.has(k)) continue;
                            seenT.add(k);
                            tryOption('drop', cx0, 2, from, fallT);
                        }
                    }
                }
            }
        }
        return options;
    }

    // Remember an edge that did not work out, so plans avoid it for a while
    markFailed(from, to, frame) {
        this.failed = this.failed.filter(f => frame - f.frame < 240);
        this.failed.push({ from, to, frame });
    }

    failPenalty(from, to, frame) {
        let pen = 0;
        for (const f of this.failed) if (f.from === from && f.to === to && frame - f.frame < 240) pen += 90;
        return pen;
    }

    // Dijkstra from `start`. Returns { best: Map(node -> {cost, x, depth, edge, prev}), goal, steps, score }.
    // o: edge options plus { maxDepth, t0, nodeOk(p, cost), canLeave(p, state), extraCost(p, edge),
    //                        goal(p) -> bool, score(p, cost, state) -> number (lower is better) }
    search(start, startX, o) {
        const best = new Map();
        best.set(start, { cost: 0, x: startX, depth: 0, edge: null, prev: null });
        const open = [start];
        const done = new Set();
        const maxDepth = o.maxDepth || 4;
        const t0 = o.t0 || 0;
        let goal = null, goalScore = Infinity;
        if (o.score && !o.skipStartScore) {
            goalScore = o.score(start, 0, best.get(start));
            goal = start;
        }
        while (open.length) {
            let bi = 0;
            for (let i = 1; i < open.length; i++) if (best.get(open[i]).cost < best.get(open[bi]).cost) bi = i;
            const cur = open.splice(bi, 1)[0];
            if (done.has(cur)) continue;
            done.add(cur);
            const st = best.get(cur);
            if (o.goal && o.goal(cur)) { goal = cur; break; }
            if (o.score && cur !== start) {
                const s = o.score(cur, st.cost, st);
                if (s < goalScore) { goalScore = s; goal = cur; }
            }
            if (st.depth >= maxDepth) continue;
            if (o.canLeave && !o.canLeave(cur, st)) continue;
            for (const nb of o.cands) {
                if (nb === cur || done.has(nb)) continue;
                const e = this.edge(cur, st.x, t0 + st.cost, nb, o);
                if (!e) continue;
                let cost = st.cost + e.frames + this.failPenalty(cur, nb, o.frame);
                if (o.extraCost) cost += o.extraCost(nb, e);
                if (o.nodeOk && !o.nodeOk(nb, cost)) continue;
                const old = best.get(nb);
                if (!old || cost < old.cost) {
                    best.set(nb, { cost, x: e.arriveX, depth: st.depth + 1, edge: e, prev: cur });
                    open.push(nb);
                }
            }
        }
        const steps = [];
        for (let n = goal; n && best.get(n) && best.get(n).edge; n = best.get(n).prev) steps.unshift(best.get(n).edge);
        return { best, goal, steps, score: goalScore };
    }
}

// ============================================
// 4. CONTROLLER
// ============================================
class AIController {
    constructor(player, opponent, opts) {
        opts = opts || {};
        this.me = player;
        this.foe = opponent;
        this.difficulty = opts.difficulty !== undefined ? opts.difficulty : settings.aiDiff;
        this.profile = AI_PROFILES[this.difficulty] || AI_PROFILES[1];
        this.swapKey = opts.swapKey || 'ShiftRight';
        this.nav = new AINav();
        this.bulletInfo = new WeakMap();
        this.reset();
    }

    reset() {
        this.frame = 0;
        this.lastThink = -999;
        this.goal = null;
        this.plan = null;
        this.planFrame = -999;
        this.air = null;
        this.pending = null;        // edge we took off for (to detect failed jumps)
        this.stance = { engage: true, dodge: true, dodgeMult: 1 };
        this.airDebt = 0;           // frames spent in the air because of dodge jumps (leaky)
        this.history = [];          // recent snapshots of the enemy (perception lag)
        this.aimNoise = 0;
        this.aimNoiseFrame = -999;
        this.jumpOut = false;       // what we output for the jump key last frame
        this.downOut = false;
        this.swapOut = false;
        this.hopUntil = 0;
        this.lavaClear();
        this.clearWants();
        this.releaseKeys();
    }

    onRespawn() {
        this.goal = null;
        this.plan = null;
        this.air = null;
        this.pending = null;
        this.lavaClear();
    }

    get shotCooldown() { return this.profile.shotCooldown; }

    clearWants() {
        this.wantsLeft = false;
        this.wantsRight = false;
        this.wantsJump = false;
        this.wantsDoubleJump = false;
        this.wantsDown = false;
        this.wantsShoot = false;
        this.wantsSwap = false;
    }

    releaseKeys() {
        const c = this.me.controls;
        keys[c.left] = false;
        keys[c.right] = false;
        keys[c.jump] = false;
        keys[c.shoot] = false;
        keys[c.down] = false;
        keys[this.swapKey] = false;
    }

    // ---------- main loop ----------
    update() {
        this.frame++;
        this.clearWants();
        this.phys = aiPhysics(this.me);
        this.sense();
        if (settings.gameMode === 4) {
            this.updateLava();
        } else {
            this.updateArena();
        }
        this.updateDodge();
        this.updateFire();
        this.applyInputs();
    }

    sense() {
        const f = this.foe;
        this.history.push({ x: f.x, y: f.y, vx: f.vx, vy: f.vy, onGround: f.onGround });
        if (this.history.length > 40) this.history.shift();
        if (this.frame - this.aimNoiseFrame >= this.profile.aimHold) {
            this.aimNoise = aiGauss() * this.profile.aimError;
            this.aimNoiseFrame = this.frame;
        }
    }

    // The enemy as the bot perceives it: `reaction` frames old
    foeSeen() {
        const lag = Math.min(this.history.length - 1, this.profile.reaction);
        return this.history[this.history.length - 1 - Math.max(0, lag)] || this.foe;
    }

    // ---------- helpers ----------
    nodeOf(player) {
        if (player.onGround && player.standingOn) return player.standingOn;
        const res = aiSimFlight(player.x + AI_PW / 2, player.y + AI_PH, player.vy, player.x + AI_PW / 2, this.phys, platforms, 0, { maxFrames: 120 });
        return res ? res.plat : null;
    }

    pickupNode(item) {
        for (const p of platforms) {
            if (item.x + item.w > p.x && item.x < p.x + p.w && Math.abs(item.y + item.h + 4 - p.y) < 8) return p;
        }
        return null;
    }

    navOpts(extra) {
        return Object.assign({
            phys: this.phys,
            cands: platforms,
            margin: this.profile.edgeMargin,
            maxDrop: 1000,
            allowDrop: true,
            cacheTTL: Infinity,
            frame: this.frame,
            maxDepth: 6,
        }, extra || {});
    }

    // Travel costs (frames) from a node to every other node
    distanceField(node, x, extra) {
        if (!node) return new Map();
        return this.nav.search(node, x, this.navOpts(extra)).best;
    }

    fieldCost(field, node) {
        const e = field.get(node);
        return e ? e.cost : Infinity;
    }

    currentCooldown() {
        let cd = this.profile.shotCooldown;
        if (this.me.hasPowerup('nocooldown')) cd = Math.floor(cd * 0.5);
        return cd;
    }

    hasAmmo() {
        return settings.infiniteAmmo === 0 || this.me.ammo > 0;
    }

    // ---------- arena modes (Classic, One Shot, King of the Hill, Tag) ----------
    updateArena() {
        const P = this.profile;
        const due = this.frame - this.lastThink >= P.reaction;
        if (due || !this.goal) {
            this.lastThink = this.frame;
            if (!this.goal || Math.random() >= P.hesitation) {
                const mode = settings.gameMode;
                if (mode === 2) this.thinkKoth();
                else if (mode === 3) this.thinkTag();
                else this.thinkDuel(mode === 1);
            }
        }
        this.steer();
    }

    // Walk toward x. On ice, steer the sliding speed instead of the position so we don't
    // shoot past the spot (or off the edge). Returns true once we're there.
    walkTo(x, tol) {
        const me = this.me;
        const cx = me.x + AI_PW / 2;
        const dx = x - cx;
        if (me.standingOn && me.standingOn.ice) {
            const wantVx = aiClamp(dx * 0.08, -this.phys.speed, this.phys.speed);
            const dv = wantVx - me.vx;
            if (dv > 0.3) this.wantsRight = true;
            else if (dv < -0.3) this.wantsLeft = true;
            return Math.abs(dx) <= tol + 4;
        }
        if (Math.abs(dx) <= tol) return true;
        if (dx > 0) this.wantsRight = true; else this.wantsLeft = true;
        return false;
    }

    steerAir(target) {
        const cx = this.me.x + AI_PW / 2;
        if (target > cx + this.phys.speed * 0.5) this.wantsRight = true;
        else if (target < cx - this.phys.speed * 0.5) this.wantsLeft = true;
    }

    // Execute the current goal on the ground / in the air
    steer() {
        const me = this.me;
        if (!me.onGround) {
            this.airControl();
            return;
        }
        if (this.pending) {
            // we took off for pending.to - did we get there?
            if (me.standingOn !== this.pending.to && me.standingOn !== this.pending.from) {
                this.nav.markFailed(this.pending.from, this.pending.to, this.frame);
            } else if (me.standingOn === this.pending.from && this.pending.kind === 'jump' && this.frame - this.pending.frame > 12) {
                this.nav.markFailed(this.pending.from, this.pending.to, this.frame);
            }
            this.pending = null;
        }
        this.air = null;
        const g = this.goal;
        if (!g) return;
        const plat = me.standingOn;
        if (!plat) return;

        if (!g.node || g.node === plat) {
            this.plan = null;
            this.holdPosition(g);
            return;
        }

        // Travel: (re)plan when the goal changed, the plan broke, or it is getting old
        const stale = !this.plan || this.plan.target !== g.node || this.plan.steps.length === 0 ||
            this.plan.steps[0].from !== plat || this.frame - this.planFrame > 45;
        if (stale) {
            const res = this.nav.search(plat, me.x + AI_PW / 2, this.navOpts({ goal: p => p === g.node, maxDepth: 8 }));
            this.plan = { target: g.node, steps: res.goal === g.node ? res.steps : [] };
            this.planFrame = this.frame;
        }
        if (this.plan.steps.length === 0) {
            this.fallbackMove(g);
            return;
        }
        this.followStep(this.plan.steps[0]);
    }

    // Stand where the goal says, within the platform
    holdPosition(g) {
        const me = this.me;
        const plat = me.standingOn;
        const [plo, phi] = AINav.standRange(plat, plat.w, 10, plat.ice);
        let lo = g.lo !== undefined ? Math.max(plo, g.lo) : plo;
        let hi = g.hi !== undefined ? Math.min(phi, g.hi) : phi;
        if (lo > hi) { lo = plo; hi = phi; } // the platform is too small for the requested distance
        const myCX = me.x + AI_PW / 2;
        const x = aiClamp(g.x !== undefined && g.x !== null ? g.x : myCX, lo, hi);
        const tol = g.tol !== undefined ? g.tol : 6;

        // Cornered by an enemy on our level: jump over them instead of backing into the wall (Medium / Hard)
        if (g.hopOver && this.profile.hopOver && this.frame > this.hopUntil) {
            const foe = this.foe;
            const dxF = (foe.x + AI_PW / 2) - myCX;
            const sameLevel = Math.abs(foe.y - me.y) < 30 && foe.onGround;
            const close = Math.abs(dxF) < 70;
            const wantDir = Math.sign(x - myCX);
            const blocked = Math.abs(x - myCX) < 8 && Math.abs(dxF) < 50;   // nowhere left to go
            const inTheWay = wantDir !== 0 && Math.sign(dxF) === wantDir && Math.abs(dxF) < 40;
            if (sameLevel && close && (blocked || inTheWay)) {
                this.wantsJump = true;
                const dir = Math.sign(dxF) || 1;
                this.air = { hop: aiClamp(foe.x + AI_PW / 2 + dir * 90, plo, phi) };
                this.hopUntil = this.frame + 50;
                return;
            }
        }
        this.walkTo(x, tol);
    }

    // No route: at least head in the right direction (and hop if it is right above us)
    fallbackMove(g) {
        const me = this.me;
        const tx = g.x !== undefined && g.x !== null ? g.x : (g.node ? aiCX(g.node) : null);
        if (tx === null) return;
        const cx = me.x + AI_PW / 2;
        const arrived = this.walkTo(tx, 12);
        if (g.node && g.node.y < me.y && arrived) this.wantsJump = true;
        if (g.node && g.node.y > me.y + AI_PH && arrived && settings.dropThrough === 0 && !me.standingOn.isGround) {
            this.wantsDown = true;
        }
    }

    // On the ground: walk to the take-off spot, then jump (or drop) toward the landing spot
    followStep(step) {
        const me = this.me;
        const cx = me.x + AI_PW / 2;
        if (step.kind === 'drop') {
            if (step.through) {
                if (!this.walkTo(step.cx0, 6)) return;
                this.wantsLeft = this.wantsRight = false;
                this.wantsDown = true;
                this.air = { step, i: 0, prevVy: 0 };
                this.pending = { from: step.from, to: step.to, kind: step.kind, frame: this.frame };
            } else {
                // keep walking off the edge; air control takes over once we fall
                this.walkTo(step.cx0, 0);
                this.air = { step, i: 0, prevVy: 0 };
                this.pending = { from: step.from, to: step.to, kind: step.kind, frame: this.frame };
            }
            return;
        }
        if (!this.walkTo(step.cx0, Math.max(3, this.phys.speed * 0.6))) return;
        this.wantsLeft = false;
        this.wantsRight = false;
        this.wantsJump = true;
        if (step.xL > cx + 2) this.wantsRight = true;
        else if (step.xL < cx - 2) this.wantsLeft = true;
        const idx = this.plan ? this.plan.steps.indexOf(step) : -1;
        this.air = { step, steps: idx >= 0 ? this.plan.steps.slice(idx) : [step], i: 0, prevVy: 0 };
        this.pending = { from: step.from, to: step.to, kind: step.kind, frame: this.frame };
    }

    // In the air: steer to the planned landing spot, otherwise pick the best landing we can still make
    airControl() {
        const me = this.me;
        const phys = this.phys;
        const cx = me.x + AI_PW / 2;
        const feet = me.y + AI_PH;
        const air = this.air;
        let target = null;

        if (air && air.hop !== undefined) {
            target = air.hop;
        } else if (air && air.dodge) {
            target = null; // dropped through: pick a landing below
        } else if (air && air.steps) {
            // Launched by a bounce pad we were aiming for: continue with the next planned jump
            const cur = air.steps[air.i];
            const justBounced = air.prevVy > 0 && me.vy < 0;
            if (cur && cur.to.bounce && justBounced && air.i + 1 < air.steps.length) air.i++;
            air.prevVy = me.vy;
            const s = air.steps[air.i];
            if (s && platforms.includes(s.to)) {
                const frames = aiLandFrames(me.vy, feet, s.to, phys.g);
                if (frames > 0) {
                    const pos = aiIsMoving(s.to) ? aiPlatAt(s.to, frames) : s.to;
                    const [llo, lhi] = AINav.standRange(pos, s.to.w, 8, s.to.ice);
                    const xL = aiClamp(pos.x + s.landOffset, llo, lhi);
                    if (Math.abs(xL - cx) <= phys.speed * frames + 8) target = xL;
                }
            }
        } else if (air && air.step) {
            const s = air.step;
            if (platforms.includes(s.to)) {
                const frames = aiLandFrames(me.vy, feet, s.to, phys.g);
                if (frames > 0) {
                    const pos = aiIsMoving(s.to) ? aiPlatAt(s.to, frames) : s.to;
                    const [llo, lhi] = AINav.standRange(pos, s.to.w, 8, s.to.ice);
                    const xL = aiClamp(pos.x + s.landOffset, llo, lhi);
                    if (Math.abs(xL - cx) <= phys.speed * frames + 8) target = xL;
                }
            }
        }

        if (target === null) {
            this.air = null;
            target = this.pickLanding();
        }
        if (target !== null) this.steerAir(target);
        return target;
    }

    // Plan lost (knocked off course, dodged, platform broke): the best landing we can still reach
    pickLanding() {
        const me = this.me;
        const phys = this.phys;
        const cx = me.x + AI_PW / 2;
        const feet = me.y + AI_PH;
        const g = this.goal;
        const goalNode = g && g.node ? g.node : (this.lavaLastPlat || null);
        const goalX = g && g.x !== undefined && g.x !== null ? g.x : cx;
        const goalY = goalNode ? goalNode.y : feet;
        const lava = settings.gameMode === 4;
        const options = [];
        for (const p of platforms) {
            if (lava && (p.y < -lavaState.cameraY || p.y > lavaState.lavaY - 10)) continue;
            if (lava && p.bounce && p.y - phys.bounceH - AI_PH < -lavaState.cameraY) continue;
            const frames = aiFlightFrames(me.vy, p.y - feet, phys.g);
            if (frames < 0) continue;
            const pos = aiIsMoving(p) ? aiPlatAt(p, frames) : p;
            const [llo, lhi] = AINav.standRange(pos, p.w, 10, p.ice);
            if (llo > lhi) continue;
            const xL = aiClamp(goalNode === p ? goalX : cx, llo, lhi);
            if (Math.abs(xL - cx) > phys.speed * frames) continue;
            let score = Math.abs(xL - cx) * 0.3 + frames * 0.5;
            if (p === goalNode) score -= 300;
            else if (lava) score += Math.max(0, p.y - (-lavaState.cameraY + AI_LAVA.GOAL_LINE)) + (3 - this.lavaUpDepth(p)) * 60;
            else score += Math.abs(p.y - goalY) * 0.5 + Math.abs(aiCX(p) - goalX) * 0.2;
            if (p.breakable && p.breakTimer > 0) score += 300;
            if (p.bounce) score += 200;
            options.push({ p, xL, score });
        }
        options.sort((a, b) => a.score - b.score);
        for (const o of options.slice(0, 4)) {
            const res = aiSimFlight(cx, feet, me.vy, o.xL, phys, platforms, 0, { deathY: settings.gameMode === 4 ? lavaState.lavaY : Infinity });
            if (res && res.plat === o.p) return o.xL;
        }
        return options.length ? options[0].xL : null;
    }

    // ---------- shooting ----------
    updateFire() {
        const me = this.me, foe = this.foe, P = this.profile;
        this.wantsShoot = false;
        if (!this.stance.engage) return;
        if (!this.hasAmmo() || foe.hp <= 0) return;
        if (P.seesShield && foe.hasPowerup('invincible')) return;

        const seen = this.foeSeen();
        const dx = (foe.x - me.x);
        const dist = Math.abs(dx);
        const range = (me.hasPowerup('rapidfire') ? BULLET_SPEED * 2.5 : BULLET_SPEED) * AI_BULLET_LIFE - 60;
        if (dist > range || dist < 16) return;

        // Where will the enemy be when the bullet arrives?
        let aimY = seen.y;
        if (P.predictAim && !foe.onGround) {
            const t = Math.max(0, (dist - 36) / (me.hasPowerup('rapidfire') ? BULLET_SPEED * 2.5 : BULLET_SPEED));
            aimY = aiPredictY(foe, Math.round(t), this.phys.g);
        } else if (!foe.onGround && !P.predictAim) {
            aimY = seen.y; // shoots at where it saw the enemy - a jumping enemy is hard to hit for Easy/Medium
        }
        aimY += this.aimNoise;
        if (!aiCanHitY(me.y, aimY, 3)) return;
        if (this.lineBlocked(me, foe)) return;

        const dir = dx > 0 ? 1 : -1;
        const movingAway = (this.wantsLeft && dir > 0) || (this.wantsRight && dir < 0);
        const cooldownReady = Date.now() - me.lastShot >= this.currentCooldown();
        if (!cooldownReady) return; // never hold the key: a retreating shot would go backwards
        if (movingAway) {
            if (!P.stopAndShoot || !me.onGround) return; // mid-air steering is worth more than a backwards shot
            this.wantsLeft = false;
            this.wantsRight = false;
        }
        if (!this.wantsLeft && !this.wantsRight) me.facing = dir;
        this.wantsShoot = true;
    }

    // Is a platform in the way of a shot from me to foe? (bullets break on platforms)
    lineBlocked(me, foe) {
        const by = me.y + AI_BULLET_DY;
        const x1 = Math.min(me.x + AI_PW / 2, foe.x + AI_PW / 2), x2 = Math.max(me.x + AI_PW / 2, foe.x + AI_PW / 2);
        for (const p of platforms) {
            if (p.y < by + AI_BULLET_H && p.y + p.h > by && p.x < x2 && p.x + p.w > x1) return true;
        }
        return false;
    }

    // ---------- dodging ----------
    // A jump clears a bullet in 3 frames but keeps us in the air for 40, where we can neither shoot
    // nor dodge again. So: drop through the platform when there is time (we leave the line of fire
    // for good), jump otherwise, and stop jumping altogether when we have been airborne too much.
    updateDodge() {
        const me = this.me, foe = this.foe, P = this.profile;
        if (!me.onGround && this.air && this.air.dodge) this.airDebt = Math.min(120, this.airDebt + 1);
        else this.airDebt = Math.max(0, this.airDebt - 0.6);
        if (!this.stance.dodge) return;
        for (const b of foe.bullets) {
            let info = this.bulletInfo.get(b);
            if (!info) {
                info = { seen: this.frame, dodge: Math.random() < Math.min(1, P.dodgeSkill * (this.stance.dodgeMult || 1)) };
                this.bulletInfo.set(b, info);
            }
            if (!info.dodge) continue;
            if (this.frame - info.seen < P.reaction) continue; // not noticed yet
            const toward = (b.vx > 0 && b.x < me.x) || (b.vx < 0 && b.x > me.x + me.w);
            if (!toward) continue;
            const gap = b.vx > 0 ? me.x - (b.x + b.w) : b.x - (me.x + me.w);
            const tti = gap / Math.abs(b.vx);
            if (tti > P.dodgeWindow) continue;
            const myY = aiPredictY(me, Math.ceil(tti), this.phys.g);
            if (!(b.y + b.h > myY && b.y < myY + AI_PH)) continue; // passes above or below
            if (me.onGround) {
                const plat = me.standingOn;
                const canDrop = this.stance.dropDodge !== false && settings.dropThrough === 0 && plat && !plat.isGround && tti >= 7;
                if (canDrop) {
                    this.wantsDown = true;
                    this.wantsLeft = this.wantsRight = false;
                    this.air = { dodge: true };
                    this.plan = null;
                } else if (tti >= 1.5 && this.airDebt < 45) {
                    this.wantsJump = true;
                    this.air = { hop: me.x + AI_PW / 2, dodge: true }; // come straight back down
                    this.plan = null;
                }
            } else if (me.doubleJumps > 0 && me.vy > -2 && P.itemIQ > 0.3 && this.canDoubleJump()) {
                this.wantsDoubleJump = true;
            }
            break;
        }
    }

    canDoubleJump() {
        const me = this.me;
        if (me.vy < 0) return true;
        const feetY = me.y + AI_PH;
        for (const p of platforms) {
            if (p.bounce) continue;
            if (me.x + AI_PW > p.x && me.x < p.x + p.w && feetY <= p.y && feetY + 25 > p.y) return false;
        }
        return true;
    }

    // ---------- key output ----------
    applyInputs() {
        const me = this.me;
        const c = me.controls;
        let L = this.wantsLeft, R = this.wantsRight, J = this.wantsJump, D = this.wantsDown;

        // Double jump needs the key released for one frame first
        if (this.wantsDoubleJump && !me.onGround) {
            J = !this.jumpOut;
        }
        // Drop-through / platform spawn need a fresh press
        if (D && this.downOut) D = false;

        // Inverted controls: the game swaps left/right and jump/down - compensate once we "noticed"
        if (me.invertedUntil && Date.now() < me.invertedUntil) {
            const since = Date.now() - (me.invertedUntil - POWERUP_TYPES.invert.duration);
            if (since >= this.profile.invertAdapt) {
                [L, R] = [R, L];
                [J, D] = [D, J];
            }
        }
        if (L && R) { L = false; R = false; }

        keys[c.left] = L;
        keys[c.right] = R;
        keys[c.jump] = J;
        keys[c.down] = D;
        keys[c.shoot] = this.wantsShoot;
        // Swap needs a fresh press as well: only the first frame of a request presses the key
        keys[this.swapKey] = this.wantsSwap && !this.swapOut;
        this.swapOut = this.wantsSwap;
        this.jumpOut = J;
        this.downOut = D;
    }

    // ============================================
    // 5a. CLASSIC / ONE SHOT
    // ============================================
    thinkDuel(oneShot) {
        const me = this.me, foe = this.foe, P = this.profile;
        const myNode = this.nodeOf(me);
        const foeNode = this.nodeOf(foe);
        this.stance = { engage: true, dodge: true, dodgeMult: oneShot ? 1.15 : 1 };
        if (!myNode) { this.goal = null; return; }
        const cx = me.x + AI_PW / 2;
        const field = this.distanceField(myNode, cx);
        const foeField = (P.pickupIQ > 0.6 && foeNode) ? this.distanceField(foeNode, foe.x + AI_PW / 2) : null;
        const limited = settings.infiniteAmmo === 1;
        const candidates = [];
        const travel = (node) => this.fieldCost(field, node);

        // --- Ammo ---
        if (limited && me.ammo <= Math.max(P.ammoReserve, 1) + 3) {
            for (const ap of ammoPickups) {
                const n = this.pickupNode(ap);
                if (!n) continue;
                const c = travel(n);
                if (c === Infinity) continue;
                if (Date.now() - ap.spawnTime + c * 17 > 7800) continue; // gone before we get there
                let u = (me.ammo <= 0 ? 170 : me.ammo <= P.ammoReserve ? 120 : 55) - c * 0.25;
                if (foeField && this.fieldCost(foeField, n) < c * 0.6 && me.ammo > 0) u -= 40;
                candidates.push({ type: 'ammo', node: n, x: aiCX(ap), tol: 4, u });
            }
        }

        // --- Power-ups ---
        for (const pu of powerups) {
            const n = this.pickupNode(pu);
            if (!n) continue;
            const value = this.powerupValue(pu.type, oneShot);
            if (value <= 0) continue;
            const c = travel(n);
            if (c === Infinity) continue;
            if (!pu.permanent && Date.now() - pu.spawnTime + c * 17 > 9800) continue;
            let u = value - c * 0.25;
            if (foeField && this.fieldCost(foeField, n) < c * 0.6) u -= value * 0.6; // the enemy gets there first
            if (P.pickupIQ < 0.6 && c > 150) continue; // Easy only grabs what is close
            candidates.push({ type: 'powerup', node: n, x: aiCX(pu), tol: 4, u });
        }

        // --- Fight / evade ---
        const canFight = this.hasAmmo() && !(P.seesShield && foe.hasPowerup('invincible'));
        const foeY = this.foeGroundY(foe, foeNode);
        if (canFight) {
            const spot = this.attackSpot(foeY, foeNode, field, oneShot);
            if (spot) {
                let u = 60 - spot.cost * 0.1;
                if (foe.hp <= 20 || (limited && foe.ammo <= 0)) u += 25; // press the advantage
                candidates.push({ type: 'fight', node: spot.node, x: spot.x, tol: spot.tol, lo: spot.lo, hi: spot.hi, hopOver: true, u });
            }
        }
        if (!canFight || (oneShot && foe.hasPowerup('invincible'))) {
            const spot = this.evadeSpot(foeY, foeNode, field);
            if (spot) candidates.push({ type: 'evade', node: spot.node, x: spot.x, tol: 10, u: 50 });
            this.stance.engage = canFight;
        }

        if (candidates.length === 0) { this.goal = null; return; }
        // Hysteresis: keep the current goal unless something is clearly better
        for (const c of candidates) {
            if (this.goal && this.goal.type === c.type && this.goal.node === c.node) c.u += 8;
        }
        candidates.sort((a, b) => b.u - a.u);
        this.goal = candidates[0];
    }

    // Enemy's top edge once it lands (so a hopping enemy does not make us switch platforms all the time)
    foeGroundY(foe, foeNode) {
        if (foe.onGround || !foeNode) return foe.y;
        return foeNode.y - AI_PH;
    }

    powerupValue(type, oneShot) {
        const me = this.me, P = this.profile;
        const maxHp = HP_OPTIONS[settings.hp];
        let v = 0;
        switch (type) {
            case 'heal': v = oneShot ? 0 : (me.hp < maxHp * 0.5 ? 95 : me.hp < maxHp * 0.8 ? 45 : 10); break;
            case 'invincible': v = oneShot ? 110 : 70; break;
            case 'damage': v = oneShot ? 20 : 70; break;
            case 'rapidfire': v = 55; break;
            case 'nocooldown': v = 55; break;
            case 'megaknockback': v = 40; break;
            case 'noknockback': v = 35; break;
            case 'speedboost': v = 40; break;
            case 'doublejump': v = 35; break;
            case 'superjump': v = 25; break;
            case 'invert': v = 50; break;
            case 'swap': v = 15; break;
            default: v = 0;
        }
        // Easy barely tells power-ups apart
        return v * P.pickupIQ + (v > 0 ? 45 * (1 - P.pickupIQ) : 0);
    }

    // Where to stand to shoot the enemy: a platform at its height, at the preferred distance
    attackSpot(foeY, foeNode, field, oneShot) {
        const me = this.me, foe = this.foe, P = this.profile;
        const foeCX = foe.x + AI_PW / 2;
        const myCX = me.x + AI_PW / 2;
        const [bandLo, bandHi] = P.rangeBand;
        const ideal = (bandLo + bandHi) / 2;
        let best = null;
        for (const n of platforms) {
            const standY = n.y - AI_PH;
            if (!aiCanHitY(standY, foeY, 4)) continue;
            const cost = this.fieldCost(field, n);
            if (cost === Infinity) continue;
            const [lo, hi] = AINav.standRange(n, n.w, 10);
            // stay on the side we are on, unless there is no room for the minimum distance there
            let side = Math.sign(myCX - foeCX) || (foeCX < 400 ? 1 : -1);
            if (foeCX + side * bandLo < lo || foeCX + side * bandLo > hi) side = -side;
            const x = aiClamp(foeCX + side * ideal, lo, hi);
            const dist = Math.abs(x - foeCX);
            let score = -cost * 0.1 - Math.abs(dist - ideal) * 0.05;
            if (dist < bandLo * 0.5) score -= oneShot ? 60 : 20; // tiny platform shared with the enemy
            if (n === foeNode && oneShot) score -= 10;
            if (n === me.standingOn) score += 6;
            if (!best || score > best.score) {
                // never walk closer than bandLo on purpose (holdPosition drops the bound if the platform is too small)
                best = {
                    node: n, x, cost, score, tol: (bandHi - bandLo) / 2,
                    lo: side > 0 ? foeCX + bandLo : undefined,
                    hi: side < 0 ? foeCX - bandLo : undefined,
                };
            }
        }
        if (best) return best;
        // Nothing at the enemy's height is reachable: get as close as we can
        let near = null;
        for (const n of platforms) {
            const cost = this.fieldCost(field, n);
            if (cost === Infinity) continue;
            const score = -cost * 0.1 - Math.abs(n.y - AI_PH - foeY) * 0.3 - Math.abs(aiCX(n) - foeCX) * 0.05;
            if (!near || score > near.score) near = { node: n, x: aiClamp(foeCX, ...AINav.standRange(n, n.w, 10)), cost, score, tol: 20 };
        }
        return near;
    }

    // Somewhere the enemy cannot shoot us from where it is
    evadeSpot(foeY, foeNode, field) {
        const foe = this.foe;
        const foeCX = foe.x + AI_PW / 2;
        let best = null;
        for (const n of platforms) {
            const cost = this.fieldCost(field, n);
            if (cost === Infinity) continue;
            const standY = n.y - AI_PH;
            const aligned = aiCanHitY(standY, foeY, -12);
            let score = -cost * 0.15 + (aligned ? -80 : 0) + Math.abs(n.y - foe.y) * 0.3;
            const [lo, hi] = AINav.standRange(n, n.w, 12);
            const x = foeCX < aiCX(n) ? hi : lo;
            score += Math.abs(x - foeCX) * 0.1;
            if (this.goal && this.goal.type === 'evade' && this.goal.node === n) score += 40; // don't flip-flop
            if (!best || score > best.score) best = { node: n, x, score };
        }
        return best;
    }

    // How many other platforms can be reached directly from n (dead ends have 0-1)
    exitCount(n) {
        if (!this.exitCache || this.exitCache.frame !== this.frame) this.exitCache = { frame: this.frame, map: new Map() };
        if (this.exitCache.map.has(n)) return this.exitCache.map.get(n);
        const o = this.navOpts();
        let count = 0;
        for (const m of platforms) if (m !== n && this.nav.edge(n, aiCX(n), 0, m, o)) count++;
        this.exitCache.map.set(n, count);
        return count;
    }

    // ============================================
    // 5b. KING OF THE HILL
    // ============================================
    thinkKoth() {
        const me = this.me, foe = this.foe, P = this.profile;
        const hill = platforms.find(p => p.isHill);
        const hz = kothState.hillZone;
        this.stance = { engage: true, dodge: true, dodgeMult: 1 };
        if (!hill || !hz) { this.thinkDuel(false); return; }
        const inZone = (pl) => pl.x + pl.w > hz.x && pl.x < hz.x + hz.w && pl.y + pl.h > hz.y && pl.y < hz.y + hz.h;
        const meIn = inZone(me), foeIn = inZone(foe);
        const [zlo, zhi] = [hz.x + AI_PW / 2 + 2, hz.x + hz.w - AI_PW / 2 - 2];
        const foeCX = foe.x + AI_PW / 2, myCX = me.x + AI_PW / 2;
        const myNode = this.nodeOf(me);
        const contested = meIn && foeIn;

        const noAmmo = settings.infiniteAmmo === 1 && me.ammo <= 0;
        const foeArmed = settings.infiniteAmmo === 0 || foe.ammo > 0;
        if (meIn) {
            // Trading shots wins the hill, jumping loses it: every dodge jump leaves the zone for half a
            // second, which is exactly what the enemy wants. So on the hill we take the hits.
            this.stance.dodge = false;
            this.stance.dropDodge = false;
            // Ammo is scarce: two or three hits push an intruder off the hill, which is cheaper than
            // a kill. Shots at an enemy far from the hill are wasted.
            this.stance.engage = contested || Math.abs(foeCX - myCX) < 150 ||
                (aiCanHitY(me.y, foe.y, 2) && Math.abs(foeCX - myCX) < 320 && me.ammo >= 6);
        } else {
            this.stance.dropDodge = true;
        }

        // Without ammo nobody can be pushed off the hill. Fetch some - but don't hand the hill over for it.
        if (noAmmo && myNode) {
            const field = this.distanceField(myNode, myCX);
            const foeNode = foe.hp > 0 ? this.nodeOf(foe) : null;
            const foeField = foeNode ? this.distanceField(foeNode, foeCX) : null;
            let best = null;
            for (const ap of ammoPickups) {
                const n = this.pickupNode(ap);
                if (!n) continue;
                const c = this.fieldCost(field, n);
                if (c === Infinity || Date.now() - ap.spawnTime + c * 17 > 7800) continue;
                // the enemy is closer to it: it is theirs (Medium / Hard notice that)
                if (P.pickupIQ > 0.6 && foeField && foe.ammo <= 0 && this.fieldCost(foeField, n) + 15 < c) continue;
                if (!best || c < best.c) best = { n, c, x: aiCX(ap) };
            }
            if (best) {
                const committed = this.goal && this.goal.type === 'ammo' && this.goal.node === best.n;
                let go;
                if (!meIn) {
                    // walking into an armed king without ammo achieves little; an unarmed one we can at least block
                    go = foeArmed || !foeIn ? best.c < 260 : best.c < 120;
                } else if (contested) {
                    // armed enemy: we die anyway, come back armed. Unarmed: stalemate, break it if we are quick.
                    go = foeArmed ? best.c < 150 : best.c < 240;
                } else if (committed) {
                    go = best.c < 220;      // finish the trip we started
                } else {
                    // king: only if we are back before the enemy can threaten the hill
                    // (a dead enemy respawns at the bottom: ~3.5 s away)
                    const foeToHill = foeField ? this.fieldCost(foeField, hill) : 220;
                    go = 2 * best.c + 60 < foeToHill || (!foeArmed && best.c < 120);
                }
                if (go) {
                    this.stance.engage = false;
                    this.goal = { type: 'ammo', node: best.n, x: best.x, tol: 4 };
                    return;
                }
            }
        }

        if (meIn && me.onGround && me.standingOn === hill) {
            let x = aiClamp(myCX, zlo, zhi);
            if (foeIn) {
                // contested: keep room between us and keep shooting (knockback pushes them off)
                const side = Math.sign(myCX - foeCX) || 1;
                x = aiClamp(foeCX + side * 90, zlo, zhi);
            } else {
                // grab a power-up lying on the hill, otherwise stand roughly in the middle
                let puX = null;
                for (const pu of powerups) {
                    if (this.pickupNode(pu) === hill && this.powerupValue(pu.type, false) > 20) { puX = aiCX(pu); break; }
                }
                x = puX !== null ? aiClamp(puX, zlo, zhi) : aiClamp(myCX, zlo + 20, zhi - 20);
            }
            this.goal = { type: 'hold', node: hill, x, tol: 8, lo: zlo, hi: zhi };
            return;
        }

        // Not on the hill: go there. Swap in if the enemy is king and we are far away (Hard / Medium)
        if (P.itemIQ > 0.5 && me.swapCharges > 0 && foeIn && !meIn && myNode) {
            const field = this.distanceField(myNode, myCX);
            if (this.fieldCost(field, hill) > 90 || this.fieldCost(field, hill) === Infinity) this.wantsSwap = true;
        }
        this.goal = { type: 'hill', node: hill, x: aiClamp(hz.x + hz.w / 2, zlo, zhi), tol: 8, lo: zlo, hi: zhi };
    }

    // ============================================
    // 5c. TAG
    // ============================================
    thinkTag() {
        const me = this.me, foe = this.foe, P = this.profile;
        const isTagger = tagState.tagger === me;
        const myNode = this.nodeOf(me);
        const foeNode = this.nodeOf(foe);
        const myCX = me.x + AI_PW / 2, foeCX = foe.x + AI_PW / 2;
        if (!myNode) { this.goal = null; return; }

        if (isTagger) {
            // Chase. A bullet hit passes the tag on too, so keep shooting.
            this.stance = { engage: true, dodge: true, dodgeMult: 0.5 }; // a hit only hurts; dying sends us back to spawn
            const lead = foe.onGround ? foe.vx * 6 : 0;
            if (foeNode) {
                this.goal = { type: 'chase', node: foeNode, x: foeCX + lead, tol: 0 };
            } else {
                this.goal = { type: 'chase', node: null, x: foeCX, tol: 0 };
            }
            return;
        }

        // Run. Being hit by the tagger's bullet tags us too, so dodging matters most.
        this.stance = { engage: false, dodge: true, dodgeMult: 1.3 };
        const dist = Math.hypot(foeCX - myCX, foe.y - me.y);
        if (P.stopAndShoot && dist > 260 && foe.onGround) this.stance.engage = true; // a hit knocks the chaser back
        const myField = this.distanceField(myNode, myCX);
        const foeField = foeNode ? this.distanceField(foeNode, foeCX) : null;
        const foeClose = Math.abs(foeCX - myCX) < 130 && Math.abs(foe.y - me.y) < 30;
        let best = null;
        for (const n of platforms) {
            const mine = this.fieldCost(myField, n);
            if (mine === Infinity) continue;
            const theirs = foeField ? this.fieldCost(foeField, n) : 300;
            // the lead we would have on arrival is what counts; distance is a bonus
            let score = aiClamp(Math.min(theirs, 500) - mine, -150, 250);
            score += Math.min(theirs, 400) * 0.25;
            if (!aiCanHitY(n.y - AI_PH, foe.y, -10)) score += 50;          // out of their line of fire
            if (n === myNode) score += foeClose ? -120 : 30;                // leave when they are next to us
            if (this.goal && this.goal.type === 'flee' && this.goal.node === n) score += 25; // hysteresis
            if (this.exitCount(n) <= 1) score -= 60;                        // dead end
            const [lo, hi] = AINav.standRange(n, n.w, 12);
            let x = foeCX < aiCX(n) ? hi : lo;                              // far end of the platform
            if (n === myNode && foeClose) x = foeCX < myCX ? hi : lo;       // away from them
            if (!best || score > best.score) best = { node: n, x, score };
        }
        // Jumping over the tagger only makes sense on the ground, where there is nothing to drop down to
        this.goal = best ? { type: 'flee', node: best.node, x: best.x, tol: 10, hopOver: !!myNode.isGround && foeClose } : null;
    }

    // ============================================
    // 5d. LAVA RISE
    // ============================================
    // Every candidate jump is simulated with the real physics, a Dijkstra search over those jumps
    // plans several steps ahead toward the upper half of the screen, and every jump apex has to
    // stay on screen (the camera follows the lava, so jumping out of view means flying blind).
    lavaClear() {
        this.lavaPlan = null;
        this.lavaHoldWants = null;
        this.lavaReplanIn = 0;
        this.lavaLastPlat = null;
    }

    lavaYAt(t) {
        const frozenFrames = Math.max(0, (lavaState.freezeUntil - Date.now()) / (1000 / 60));
        return lavaState.lavaY - lavaState.lavaSpeed * Math.max(0, t - frozenFrames);
    }

    screenTopAt(t) {
        return -Math.max(0, 480 - this.lavaYAt(t));
    }

    lavaView() {
        const top = -lavaState.cameraY;
        return {
            top,
            goalY: top + AI_LAVA.GOAL_LINE,
            minJumpY: top + this.phys.jumpH + AI_PH + AI_LAVA.SCREEN_MARGIN,
        };
    }

    inWind(p) {
        const cx = p.x + p.w / 2, cy = p.y - 20;
        return lavaState.windZones.some(wz => cx > wz.x && cx < wz.x + wz.w && cy > wz.y && cy < wz.y + wz.h);
    }

    lavaPowerupValue(type) {
        switch (type) {
            case 'extralife': return 160;
            case 'doublejump': return 110;
            case 'lavafreeze': return 100;
            case 'platspawn': return 100;
            case 'superjump': return 70;
            case 'invincible': return 60;
            case 'speedboost': return 50;
            case 'heal': case 'damage': case 'megaknockback': return 30;
            default: return 0;
        }
    }

    // Can the bot stand on / pass through this platform when it gets there?
    lavaNodeOk(p, arrive) {
        const L = AI_LAVA;
        if (p.bounce) {
            return p.y - this.phys.bounceH - AI_PH >= this.screenTopAt(arrive) + L.SCREEN_MARGIN + 20;
        }
        if (p.y - AI_PH < this.screenTopAt(arrive) + L.SCREEN_MARGIN) return false;
        if (p.y > this.lavaYAt(arrive) - 10) return false;
        if (p.breakable && p.breakTimer > 0 && p.breakTimer < arrive + 15) return false;
        if (p.temporary && Date.now() - p.spawnTime + arrive * 16 > 6500) return false;
        return true;
    }

    // How good is it to end the plan on this platform? (lower = better, in frames)
    lavaNodeScore(p, cost, view, cands) {
        const L = AI_LAVA;
        const phys = this.phys;
        let score = cost;
        const goalY = this.screenTopAt(Math.max(cost, 120)) + L.GOAL_LINE;
        let worstY = p.y;
        if (p.carousel || (p.moving && p.moving.axis === 'v')) {
            for (let t = 0; t <= 90; t += 15) {
                const y = aiPlatAt(p, cost + t).y;
                worstY = Math.max(worstY, y);
                if (y - AI_PH < this.screenTopAt(cost + t)) score += 250;
            }
        }
        score += Math.max(0, worstY - goalY) * 2;
        score -= Math.max(0, goalY - worstY) * 0.4;
        if (p.breakable) score += p.breakTimer > 0 ? 1000 : 150;
        if (p.ice) score += 30;
        if (p.ice && this.inWind(p)) score += 400;
        if (p.temporary) score += 100;
        if (aiIsMoving(p)) score += 40;
        score += Math.abs(p.x + p.w / 2 - 400) * 0.04;
        score -= Math.min(p.w, 200) * 0.1;
        for (const pu of powerups) {
            if (pu.x + pu.w > p.x && pu.x < p.x + p.w && Math.abs(pu.y + pu.h - p.y) < 30) {
                score -= this.lavaPowerupValue(pu.type);
            }
        }
        // Dead end check: how many jumps can we keep going up from here? (traps like a tower that
        // ends early look fine one jump at a time, so we look three levels ahead)
        const up = this.lavaUpDepth(p);
        if (up < 3) score += (3 - up) * (p.y > view.top + 120 ? 70 : 35);
        // Easy / Medium make worse choices (stable noise per platform, so plans don't flicker)
        if (p._aiNoise === undefined) p._aiNoise = Math.random();
        score += (1 - this.profile.climbSkill) * p._aiNoise * 260;
        return score;
    }

    // Number of successive upward jumps (geometric estimate, max 3) available from platform p,
    // counting platforms that are still above the screen. Memoised per plan.
    lavaUpDepth(p, level) {
        level = level || 0;
        if (level >= 3) return 3;
        if (level === 0) {
            if (!this.upMemo || this.upMemo.frame !== this.frame) this.upMemo = { frame: this.frame, map: new Map() };
            if (this.upMemo.map.has(p)) return this.upMemo.map.get(p);
        }
        const phys = this.phys;
        const rise = p.bounce ? phys.bounceH : phys.jumpH;
        const reach = phys.speed * 28 + p.w / 2;
        let best = 0;
        for (const q of platforms) {
            if (q === p || q.breakable && q.breakTimer > 0) continue;
            const dy = q.y - p.y;
            if (!(q.bounce ? dy < 40 && dy > -rise : dy < -30 && dy > -rise - 12)) continue;
            if (Math.abs(aiCX(q) - aiCX(p)) > reach + q.w / 2) continue;
            const d = 1 + this.lavaUpDepth(q, level + 1);
            if (d > best) best = d;
            if (best >= 3 - level) break;
        }
        if (level === 0) this.upMemo.map.set(p, best);
        return best;
    }

    lavaMakePlan(view, desperate) {
        const me = this.me;
        const phys = this.phys;
        const start = me.standingOn || { x: 0, y: me.y + AI_PH, w: AI_W, h: 16, virtual: true }; // frozen lava
        const startX = me.x + AI_PW / 2;
        const cands = platforms.filter(p => p.y > view.top - (desperate ? 400 : 60) && p.y < lavaState.lavaY + 20);
        if (desperate) {
            // The lava is close and nothing on screen works: allow jumps that leave the screen for a moment
            const res = this.nav.search(start, startX, {
                phys, cands, margin: this.profile.lavaMargin, maxDrop: AI_LAVA.MAX_DROP, allowDrop: false,
                deathY: lavaState.lavaY, cacheTTL: 45, frame: this.frame, maxDepth: 3, skipStartScore: true,
                nodeOk: (nb, cost) => nb.y <= this.lavaYAt(cost) - 10 && !(nb.breakable && nb.breakTimer > 0 && nb.breakTimer < cost + 15),
                score: (p, cost) => p.bounce ? Infinity : cost + Math.max(0, p.y - (view.top + AI_LAVA.GOAL_LINE)) * 2 + (3 - this.lavaUpDepth(p)) * 80,
            });
            return { steps: res.steps, goal: res.goal, desperate: true };
        }
        const res = this.nav.search(start, startX, {
            phys, cands,
            margin: this.profile.lavaMargin,
            maxDrop: AI_LAVA.MAX_DROP,
            allowDrop: false,
            deathY: lavaState.lavaY,
            cacheTTL: 45,
            frame: this.frame,
            maxDepth: this.profile.planDepth,
            skipStartScore: start.virtual,
            canLeave: (cur, st) => cur.bounce || cur.y >= view.minJumpY - view.top + this.screenTopAt(st.cost),
            nodeOk: (nb, cost) => this.lavaNodeOk(nb, cost),
            extraCost: (nb) => (nb.breakable ? 20 : 0) + (nb.ice ? 10 : 0),
            score: (p, cost) => p.bounce ? Infinity : this.lavaNodeScore(p, cost, view, cands),
        });
        return { steps: res.steps, goal: res.goal };
    }

    updateLava() {
        const me = this.me, foe = this.foe, P = this.profile;
        const L = AI_LAVA;
        const view = this.lavaView();
        const feet = me.y + AI_PH;
        const lavaDistance = lavaState.lavaY - feet;
        const thinkFrame = this.frame - this.lastThink >= P.reaction;
        if (thinkFrame) {
            this.lastThink = this.frame;
            this.useLavaInventory(lavaDistance);
            const busy = this.lavaPlan && this.lavaPlan.steps.length > 0;
            // Shoot whenever the enemy is lined up; aim less while busy climbing
            this.stance = { engage: Math.random() < (busy ? 0.6 : 1.0), dodge: true, dodgeMult: 0.8, dropDodge: false };
        }

        if (me.onGround) {
            this.air = null;
            this.pending = null;
            const plat = me.standingOn;
            const landedNew = plat !== this.lavaLastPlat;
            this.lavaLastPlat = plat;
            if (this.lavaReplanIn > 0) this.lavaReplanIn--;
            if (plat && aiIsMoving(plat)) this.lavaReplanIn = Math.min(this.lavaReplanIn, 5);
            const planBroken = this.lavaPlan && this.lavaPlan.steps.length > 0 &&
                (this.lavaPlan.steps[0].from !== plat || !platforms.includes(this.lavaPlan.steps[0].to));
            if (!this.lavaPlan || planBroken || this.lavaReplanIn <= 0 || (landedNew && (this.difficulty > 0 || thinkFrame))) {
                if (thinkFrame || this.difficulty > 0 || !this.lavaPlan) {
                    this.lavaPlan = this.lavaMakePlan(view, false);
                    // Nothing found and the lava is coming: take risks rather than wait for it
                    if (this.lavaPlan.steps.length === 0 && lavaDistance < 170 && plat && !plat.virtual) {
                        this.lavaPlan = this.lavaMakePlan(view, true);
                    }
                    this.lavaReplanIn = L.REPLAN_FRAMES;
                }
            }
            const step = this.lavaPlan && this.lavaPlan.steps[0];
            if (step && step.from === plat) {
                this.lavaHoldWants = null;
                this.plan = { target: this.lavaPlan.goal, steps: this.lavaPlan.steps };
                this.goal = { type: 'climb', node: this.lavaPlan.goal, x: null };
                this.followStep(step);
            } else if (lavaDistance < 70 && this.lavaPlan) {
                // No way up was found and the lava is close: jump toward the middle and hope
                this.wantsJump = true;
                if (me.x + AI_PW / 2 < 400) this.wantsRight = true; else this.wantsLeft = true;
            } else if (thinkFrame || !this.lavaHoldWants) {
                this.lavaHold(plat, view);
                this.lavaHoldWants = { left: this.wantsLeft, right: this.wantsRight, jump: this.wantsJump };
            } else {
                this.wantsLeft = this.lavaHoldWants.left;
                this.wantsRight = this.lavaHoldWants.right;
                this.wantsJump = this.lavaHoldWants.jump;
            }
        } else {
            if (this.lavaHoldWants) this.lavaHoldWants.jump = false;
            this.goal = this.goal || { type: 'climb', node: null, x: null };
            this.lavaAirControl(view);
        }

        // Never start a jump whose apex would leave the screen (unless the lava forces it)
        const desperate = this.lavaPlan && this.lavaPlan.desperate;
        if (this.wantsJump && me.onGround && lavaDistance > 60 && !desperate &&
            feet - this.phys.jumpH - AI_PH < view.top + L.SCREEN_MARGIN) {
            this.wantsJump = false;
        }
    }

    lavaAirControl(view) {
        const me = this.me;
        const phys = this.phys;
        const cx = me.x + AI_PW / 2;
        const feet = me.y + AI_PH;
        const lavaDistAir = lavaState.lavaY - feet;
        const cands = platforms.filter(p => p.y > view.top - 60 && p.y < lavaState.lavaY + 20);

        // Generic steering toward the planned landing (bounce pads chain into the next jump)
        let target = this.airControl();

        // Whatever we're steering for: never come down on a bounce pad that would fling us off screen
        const flingsOff = res => res && res.plat.bounce && res.plat.y - phys.bounceH - AI_PH < view.top;
        const aim = target === null ? cx : target;
        if (flingsOff(aiSimFlight(cx, feet, me.vy, aim, phys, cands, 0))) {
            for (const xL of [cx - 400, cx + 400]) {
                if (!flingsOff(aiSimFlight(cx, feet, me.vy, xL, phys, cands, 0))) {
                    target = xL;
                    this.air = null;
                    this.wantsLeft = this.wantsRight = false;
                    this.steerAir(target);
                    break;
                }
            }
        }

        // Emergency double jump: nothing to land on, or the lava is right below
        if (me.doubleJumps > 0 && me.vy > 0.5 && (target === null || lavaDistAir < 90)) {
            const djStaysOnScreen = feet - phys.djH - AI_PH >= view.top + AI_LAVA.SCREEN_MARGIN;
            if (djStaysOnScreen || lavaDistAir < 90) this.wantsDoubleJump = true;
        }
        // Last resort: spawn a platform under our feet
        if (me.platformCharges > 0 && me.vy > 2 && target === null && lavaDistAir < 140) {
            this.wantsDown = true;
        }
    }

    // Standing in the goal band (or nowhere better to go): fight, grab power-ups, stay on the platform
    lavaHold(plat, view) {
        const me = this.me, foe = this.foe;
        const phys = this.phys;
        const cx = me.x + AI_PW / 2;
        const foeCX = foe.x + AI_PW / 2;
        if (!plat || plat.virtual) {
            // On frozen lava with no plan: get off it
            this.wantsJump = true;
            if (cx < 400) this.wantsRight = true; else this.wantsLeft = true;
            return;
        }
        // Keep away from the edges - further when the enemy can shoot us: every hit shoves us ~40 px
        // (120 with Mega Knockback), and being knocked off a platform here is usually fatal
        let margin = 14;
        const foeArmed = settings.infiniteAmmo === 0 || foe.ammo > 0;
        if (foeArmed && aiCanHitY(me.y, foe.y, -8) && !me.hasPowerup('noknockback')) {
            const kb = KNOCKBACK_OPTIONS[settings.knockback].force * (foe.hasPowerup('megaknockback') ? 3 : 1);
            margin += Math.min(80, kb / 0.15);
        }
        if (plat.w < 2 * margin + 20) margin = Math.max(10, plat.w / 2 - 10);
        const lo = plat.x + margin, hi = plat.x + plat.w - margin;
        let goalX = aiClamp(cx, lo, hi);

        // A carousel / lift about to carry us off the top of the screen: step off its edge
        if (plat.carousel || (plat.moving && plat.moving.axis === 'v')) {
            for (let t = 0; t <= 40; t += 10) {
                if (aiPlatAt(plat, t).y - AI_PH < this.screenTopAt(t) + AI_LAVA.SCREEN_MARGIN) {
                    if (cx < plat.x + plat.w / 2) this.wantsLeft = true; else this.wantsRight = true;
                    return;
                }
            }
        }
        // Power-up on this platform?
        for (const pu of powerups) {
            if (this.lavaPowerupValue(pu.type) <= 0) continue;
            const puCX = pu.x + pu.w / 2;
            if (puCX > plat.x && puCX < plat.x + plat.w && Math.abs(pu.y + pu.h - plat.y) < 30) {
                goalX = aiClamp(puCX, lo, hi);
                break;
            }
        }
        // Enemy on the same level: keep a little distance, but never walk off
        const dx = foeCX - cx;
        if (goalX === aiClamp(cx, lo, hi) && Math.abs(foe.y - me.y) < 60 && Math.abs(dx) < 110) {
            goalX = aiClamp(cx - Math.sign(dx || 1) * 60, lo, hi);
        }
        this.goal = { type: 'hold', node: plat, x: goalX };
        this.walkTo(goalX, 6);
        // Dodging must not run us off the platform (see updateDodge: it only jumps straight up)
        if (plat.ice) this.stance.dodge = false;
    }

    // Swap with the enemy if they are much higher and we're in danger
    useLavaInventory(lavaDistance) {
        const me = this.me, foe = this.foe;
        if (this.profile.itemIQ <= 0) return;
        if (me.swapCharges > 0) {
            if (foe.y + AI_PH < me.y + AI_PH - 100 && lavaDistance < 120) this.wantsSwap = true;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { AIController, AINav, AI_PROFILES, aiSimFlight, aiPhysics, aiCanHitY };
}
