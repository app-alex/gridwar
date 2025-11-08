const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// --- GAME CONSTANTS ---
const GRID_W = 40;
const GRID_H = 18;

const PROJECTILE_STEP_MS = 140;
const BULLET_RELOAD_MS = 1000;
const MAX_BULLETS = 3;

// --- TERRAIN (no holes) ---

const WALLS = [
    { x: 19, y: 8 }, { x: 20, y: 8 },
    { x: 19, y: 9 }, { x: 20, y: 9 },
    { x: 10, y: 4 }, { x: 11, y: 4 }, { x: 12, y: 4 },
    { x: 27, y: 13 }, { x: 28, y: 13 }, { x: 29, y: 13 }
];

const REFLECT_WALLS = [
    { x: 5, y: 5 },
    { x: 34, y: 5 },
    { x: 5, y: 12 },
    { x: 34, y: 12 }
];

// spikes: damage on step
const SPIKES = [
    { x: 8, y: 7 },
    { x: 31, y: 10 },
    { x: 16, y: 12 }
];

// cacti: per-room copy with "used"
const CACTI_LAYOUT = [
    { x: 14, y: 6 },
    { x: 25, y: 6 },
    { x: 20, y: 3 }
];

function isWall(x, y) {
    return WALLS.some(w => w.x === x && w.y === y);
}

function isReflectWall(x, y) {
    return REFLECT_WALLS.some(w => w.x === x && w.y === y);
}

function isSpike(x, y) {
    return SPIKES.some(s => s.x === x && s.y === y);
}

// rooms[roomId] = { players, projectiles, cacti, state, hostId, countdownTimeout, restartTimeout }
const rooms = Object.create(null);
let nextProjectileId = 1;

const COLORS = [
    "#1e90ff",
    "#e74c3c",
    "#2ecc71",
    "#9b59b6",
    "#f1c40f",
    "#e67e22",
    "#16a085",
    "#34495e"
];

// --- UTILITIES ---

function getRoomsSummary() {
    return Object.entries(rooms).map(([roomId, room]) => ({
        roomId,
        count: Object.keys(room.players).length
    }));
}

function broadcastRoomsUpdate() {
    io.emit("roomsUpdate", getRoomsSummary());
}

function ensureRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            players: {},
            projectiles: [],
            cacti: CACTI_LAYOUT.map(c => ({ ...c, used: false })),
            state: "waiting",
            hostId: null,
            countdownTimeout: null,
            restartTimeout: null
        };
    } else if (!rooms[roomId].cacti) {
        rooms[roomId].cacti = CACTI_LAYOUT.map(c => ({ ...c, used: false }));
    }
    return rooms[roomId];
}

function getColorForPlayer(roomId) {
    const room = rooms[roomId];
    const used = new Set(Object.values(room.players).map(p => p.color));
    for (const c of COLORS) {
        if (!used.has(c)) return c;
    }
    return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function isTileBlockedByPlayer(roomId, x, y, ignoreId = null) {
    const room = rooms[roomId];
    if (!room) return false;
    return Object.entries(room.players).some(
        ([id, p]) => id !== ignoreId && p.hp > 0 && p.x === x && p.y === y
    );
}

function isCactusPos(room, x, y) {
    return room.cacti && room.cacti.some(c => c.x === x && c.y === y);
}

function getCactusAt(room, x, y) {
    if (!room.cacti) return null;
    return room.cacti.find(c => c.x === x && c.y === y) || null;
}

// 🔒 now cacti are solid for players
function isBlocked(roomId, x, y, ignoreId = null) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return true;
    const room = rooms[roomId];
    if (!room) return true;
    if (isWall(x, y) || isReflectWall(x, y)) return true;
    if (isCactusPos(room, x, y)) return true;
    if (isTileBlockedByPlayer(roomId, x, y, ignoreId)) return true;
    return false;
}

function getRandomSpawn(roomId) {
    const room = rooms[roomId];
    if (!room) return { x: 0, y: 0 };

    for (let i = 0; i < 800; i++) {
        const x = Math.floor(Math.random() * GRID_W);
        const y = Math.floor(Math.random() * GRID_H);
        if (
            !isWall(x, y) &&
            !isReflectWall(x, y) &&
            !isSpike(x, y) &&
            !isCactusPos(room, x, y) &&
            !isTileBlockedByPlayer(roomId, x, y, null)
        ) {
            return { x, y };
        }
    }

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (
                !isWall(x, y) &&
                !isReflectWall(x, y) &&
                !isSpike(x, y) &&
                !isCactusPos(room, x, y) &&
                !isTileBlockedByPlayer(roomId, x, y, null)
            ) {
                return { x, y };
            }
        }
    }
    return { x: 0, y: 0 };
}

function facingFromDelta(dx, dy, currentFacing = "down") {
    if (dx === 1 && dy === 0) return "right";
    if (dx === -1 && dy === 0) return "left";
    if (dx === 0 && dy === -1) return "up";
    if (dx === 0 && dy === 1) return "down";
    return currentFacing;
}

function facingToDelta(facing) {
    switch (facing) {
        case "up": return { dx: 0, dy: -1 };
        case "down": return { dx: 0, dy: 1 };
        case "left": return { dx: -1, dy: 0 };
        case "right": return { dx: 1, dy: 0 };
        default: return { dx: 0, dy: 1 };
    }
}

// --- BULLET RELOAD ---

function reloadBullets(player) {
    const now = Date.now();
    if (player.bulletsLoaded === undefined) {
        player.bulletsLoaded = MAX_BULLETS;
        player.lastReloadTime = now;
        return true;
    }
    if (player.bulletsLoaded >= MAX_BULLETS) {
        player.lastReloadTime = now;
        return false;
    }
    if (!player.lastReloadTime) player.lastReloadTime = now;

    const elapsed = now - player.lastReloadTime;
    if (elapsed < BULLET_RELOAD_MS) return false;

    const toAdd = Math.floor(elapsed / BULLET_RELOAD_MS);
    if (toAdd <= 0) return false;

    const old = player.bulletsLoaded;
    player.bulletsLoaded = Math.min(MAX_BULLETS, player.bulletsLoaded + toAdd);
    const used = player.bulletsLoaded - old;
    player.lastReloadTime += used * BULLET_RELOAD_MS;

    return player.bulletsLoaded !== old;
}

// --- TIMERS / STATE HELPERS ---

function clearRoomTimers(room) {
    if (room.countdownTimeout) {
        clearTimeout(room.countdownTimeout);
        room.countdownTimeout = null;
    }
    if (room.restartTimeout) {
        clearTimeout(room.restartTimeout);
        room.restartTimeout = null;
    }
}

function clearProjectiles(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.projectiles = [];
    io.to(roomId).emit("clearProjectiles");
}

// --- ROUND CONTROL ---

function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);
    clearProjectiles(roomId);

    const ids = Object.keys(room.players);
    if (ids.length < 2) {
        room.state = "waiting";
        io.to(roomId).emit("roundState", {
            state: "waiting",
            hostId: room.hostId,
            cacti: room.cacti
        });
        broadcastRoomsUpdate();
        return;
    }

    // reset cactus usage each round
    if (!room.cacti) {
        room.cacti = CACTI_LAYOUT.map(c => ({ ...c, used: false }));
    } else {
        room.cacti.forEach(c => { c.used = false; });
    }

    const now = Date.now();
    ids.forEach(id => {
        const p = room.players[id];
        const spawn = getRandomSpawn(roomId);
        p.x = spawn.x;
        p.y = spawn.y;
        p.hp = 5;
        p.facing = "down";
        p.bulletsLoaded = MAX_BULLETS;
        p.lastReloadTime = now;
    });

    room.state = "countdown";
    io.to(roomId).emit("roundState", {
        state: "countdown",
        countdown: 3000,
        players: room.players,
        hostId: room.hostId,
        cacti: room.cacti
    });

    room.countdownTimeout = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        r.countdownTimeout = null;

        if (Object.keys(r.players).length < 2) {
            r.state = "waiting";
            io.to(roomId).emit("roundState", {
                state: "waiting",
                hostId: r.hostId,
                cacti: r.cacti
            });
            broadcastRoomsUpdate();
            return;
        }

        r.state = "playing";
        io.to(roomId).emit("roundState", {
            state: "playing",
            hostId: r.hostId,
            cacti: r.cacti
        });
    }, 3000);
}

// --- ROUND END ---

function handleRoundEndIfNeeded(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "playing") return;

    const alive = Object.entries(room.players).filter(([, p]) => p.hp > 0);
    if (alive.length > 1) return;

    room.state = "round_over";
    clearRoomTimers(room);
    clearProjectiles(roomId);

    let winnerId = null;
    if (alive.length === 1) {
        winnerId = alive[0][0];
        const wp = room.players[winnerId];
        wp.score = (wp.score || 0) + 1;
    }

    const scores = {};
    for (const [id, p] of Object.entries(room.players)) {
        scores[id] = p.score || 0;
    }

    io.to(roomId).emit("roundOver", {
        winnerId,
        scores,
        hostId: room.hostId,
        cacti: room.cacti
    });
}

// --- PROJECTILE TICK (includes cactus + reflect + bullet vs bullet) ---

function tickProjectilesAndReload() {
    for (const [roomId, room] of Object.entries(rooms)) {
        if (!room.players) continue;

        // reload bullets
        const ammoUpdates = [];
        for (const [pid, p] of Object.entries(room.players)) {
            if (room.state === "playing" || room.state === "countdown") {
                if (reloadBullets(p)) {
                    ammoUpdates.push({
                        id: pid,
                        bullets: p.bulletsLoaded,
                        lastReloadTime: p.lastReloadTime
                    });
                }
            }
        }
        if (ammoUpdates.length) {
            io.to(roomId).emit("ammoBulkUpdate", { updates: ammoUpdates });
        }

        if (room.state !== "playing" || !room.projectiles.length) continue;

        const projs = room.projectiles;
        const extended = projs.map(p => ({
            ...p,
            nx: p.x + p.dx,
            ny: p.y + p.dy
        }));

        const toRemove = new Set();
        const spawned = [];

        // crossing collisions
        const segMap = {};
        for (const p of extended) {
            if (p.dx === 0 && p.dy === 0) continue;
            if (p.dx !== 0) {
                const key = `h:${Math.min(p.x, p.nx)},${p.y}`;
                (segMap[key] ||= []).push(p);
            } else {
                const key = `v:${p.x},${Math.min(p.y, p.ny)}`;
                (segMap[key] ||= []).push(p);
            }
        }
        for (const key in segMap) {
            const list = segMap[key];
            if (list.length < 2) continue;
            let pos = [], neg = [];
            if (key.startsWith("h:")) {
                pos = list.filter(p => p.dx > 0);
                neg = list.filter(p => p.dx < 0);
            } else {
                pos = list.filter(p => p.dy > 0);
                neg = list.filter(p => p.dy < 0);
            }
            const pairs = Math.min(pos.length, neg.length);
            for (let i = 0; i < pairs; i++) {
                toRemove.add(pos[i].id);
                toRemove.add(neg[i].id);
            }
        }

        // same-tile opposite-direction collisions
        const tileMap = {};
        for (const p of extended) {
            if (toRemove.has(p.id)) continue;
            const key = `${p.nx},${p.ny}`;
            (tileMap[key] ||= []).push(p);
        }
        function pairCancel(aArr, bArr) {
            const pairs = Math.min(aArr.length, bArr.length);
            for (let i = 0; i < pairs; i++) {
                toRemove.add(aArr[i].id);
                toRemove.add(bArr[i].id);
            }
        }
        for (const key in tileMap) {
            const g = tileMap[key];
            if (g.length < 2) continue;
            const left = [], right = [], up = [], down = [];
            for (const p of g) {
                if (p.dx === -1) left.push(p);
                else if (p.dx === 1) right.push(p);
                else if (p.dy === -1) up.push(p);
                else if (p.dy === 1) down.push(p);
            }
            pairCancel(left, right);
            pairCancel(up, down);
        }

        const remaining = [];

        for (const p of extended) {
            if (toRemove.has(p.id)) {
                io.to(roomId).emit("projectileDestroy", { id: p.id, x: p.x, y: p.y });
                continue;
            }

            const nx = p.nx;
            const ny = p.ny;

            if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) {
                io.to(roomId).emit("projectileDestroy", { id: p.id, x: nx, y: ny });
                continue;
            }

            // reflect wall → bounce
            if (isReflectWall(nx, ny)) {
                const bounced = { ...p, x: p.x, y: p.y, dx: -p.dx, dy: -p.dy };
                delete bounced.nx; delete bounced.ny;
                remaining.push(bounced);
                io.to(roomId).emit("projectileUpdate", {
                    id: p.id,
                    x: bounced.x,
                    y: bounced.y,
                    dx: bounced.dx,
                    dy: bounced.dy
                });
                continue;
            }

            // solid wall → destroy
            if (isWall(nx, ny)) {
                io.to(roomId).emit("projectileDestroy", { id: p.id, x: nx, y: ny });
                continue;
            }

            // cactus → solid for bullets; if unused, trigger once and spawn 4
            const cactus = getCactusAt(room, nx, ny);
            if (cactus) {
                if (!cactus.used) {
                    cactus.used = true;

                    io.to(roomId).emit("projectileDestroy", {
                        id: p.id,
                        x: nx,
                        y: ny
                    });
                    io.to(roomId).emit("cactusUsed", {
                        x: cactus.x,
                        y: cactus.y
                    });

                    const dirs = [
                        { dx: 1, dy: 0 },
                        { dx: -1, dy: 0 },
                        { dx: 0, dy: 1 },
                        { dx: 0, dy: -1 }
                    ];

                    dirs.forEach(d => {
                        const sx = nx + d.dx;
                        const sy = ny + d.dy;
                        if (sx < 0 || sx >= GRID_W || sy < 0 || sy >= GRID_H) return;
                        if (isWall(sx, sy) || isReflectWall(sx, sy) || getCactusAt(room, sx, sy)) return;

                        const id2 = nextProjectileId++;
                        const proj2 = {
                            id: id2,
                            x: sx,
                            y: sy,
                            dx: d.dx,
                            dy: d.dy,
                            shooterId: p.shooterId
                        };
                        spawned.push(proj2);
                        io.to(roomId).emit("projectileSpawn", {
                            id: id2,
                            x: sx,
                            y: sy,
                            dx: d.dx,
                            dy: d.dy
                        });
                    });
                } else {
                    // already used: act like a wall for bullets
                    io.to(roomId).emit("projectileDestroy", {
                        id: p.id,
                        x: nx,
                        y: ny
                    });
                }
                continue; // important: stop processing this projectile
            }

            // spikes don't affect bullets

            // player hit
            let hitId = null;
            for (const [pid, pl] of Object.entries(room.players)) {
                if (pl.hp > 0 && pl.x === nx && pl.y === ny) {
                    hitId = pid;
                    break;
                }
            }
            if (hitId) {
                const target = room.players[hitId];
                target.hp = Math.max(0, target.hp - 1);
                io.to(roomId).emit("healthUpdate", {
                    hits: [{ id: hitId, hp: target.hp }]
                });
                io.to(roomId).emit("projectileDestroy", { id: p.id, x: nx, y: ny });
                handleRoundEndIfNeeded(roomId);
                continue;
            }

            // normal move
            const moved = { ...p, x: nx, y: ny };
            delete moved.nx; delete moved.ny;
            remaining.push(moved);
            io.to(roomId).emit("projectileUpdate", {
                id: p.id,
                x: nx,
                y: ny
            });
        }

        room.projectiles = remaining.concat(spawned);
    }
}

setInterval(tickProjectilesAndReload, PROJECTILE_STEP_MS);

// --- SOCKET EVENTS ---

io.on("connection", (socket) => {
    socket.emit("roomsUpdate", getRoomsSummary());

    socket.on("joinRoom", ({ roomId, name }) => {
        roomId = String(roomId || "").trim() || "lobby";
        const existed = !!rooms[roomId];
        const room = ensureRoom(roomId);

        socket.join(roomId);
        socket.data.roomId = roomId;

        if (!existed || !room.hostId) {
            room.hostId = socket.id;
        }

        const spawn = getRandomSpawn(roomId);
        const color = getColorForPlayer(roomId);
        const now = Date.now();

        const player = {
            x: spawn.x,
            y: spawn.y,
            color,
            name: name && name.trim()
                ? name.trim()
                : `Player-${socket.id.slice(0, 4)}`,
            hp: 5,
            facing: "down",
            score: 0,
            bulletsLoaded: MAX_BULLETS,
            lastReloadTime: now
        };

        room.players[socket.id] = player;

        socket.emit("currentState", {
            roomId,
            yourId: socket.id,
            players: room.players,
            walls: WALLS,
            reflectWalls: REFLECT_WALLS,
            spikes: SPIKES,
            cacti: room.cacti,
            gridWidth: GRID_W,
            gridHeight: GRID_H,
            state: room.state,
            hostId: room.hostId
        });

        socket.to(roomId).emit("playerJoined", { id: socket.id, player });
        io.to(roomId).emit("hostUpdate", { hostId: room.hostId });
        broadcastRoomsUpdate();
    });

    socket.on("startRound", () => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room) return;
        if (room.hostId !== socket.id) return;
        if (Object.keys(room.players).length < 2) return;
        if (room.state === "countdown" || room.state === "playing") return;
        startRound(roomId);
    });

    socket.on("move", ({ direction }) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.state !== "playing") return;

        const player = room.players[socket.id];
        if (!player || player.hp <= 0) return;

        let dx = 0, dy = 0;
        if (direction === "up") dy = -1;
        else if (direction === "down") dy = 1;
        else if (direction === "left") dx = -1;
        else if (direction === "right") dx = 1;
        else return;

        const newFacing = facingFromDelta(dx, dy, player.facing);
        const fromX = player.x;
        const fromY = player.y;
        const toX = fromX + dx;
        const toY = fromY + dy;

        player.facing = newFacing;

        if (isBlocked(roomId, toX, toY, socket.id)) {
            io.to(roomId).emit("playerMove", {
                id: socket.id,
                fromX,
                fromY,
                toX: fromX,
                toY: fromY,
                facing: player.facing
            });
            return;
        }

        player.x = toX;
        player.y = toY;

        io.to(roomId).emit("playerMove", {
            id: socket.id,
            fromX,
            fromY,
            toX,
            toY,
            facing: player.facing
        });

        // spikes damage
        if (isSpike(toX, toY) && player.hp > 0) {
            player.hp = Math.max(0, player.hp - 1);
            io.to(roomId).emit("healthUpdate", {
                hits: [{ id: socket.id, hp: player.hp }]
            });
            handleRoundEndIfNeeded(roomId);
        }
    });

    socket.on("shoot", () => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.state !== "playing") return;

        const shooter = room.players[socket.id];
        if (!shooter || shooter.hp <= 0) return;

        reloadBullets(shooter);
        if (!shooter.bulletsLoaded || shooter.bulletsLoaded <= 0) {
            socket.emit("ammoUpdate", {
                id: socket.id,
                bullets: shooter.bulletsLoaded || 0,
                lastReloadTime: shooter.lastReloadTime || Date.now()
            });
            return;
        }

        shooter.bulletsLoaded = Math.max(0, shooter.bulletsLoaded - 1);
        io.to(roomId).emit("ammoUpdate", {
            id: socket.id,
            bullets: shooter.bulletsLoaded,
            lastReloadTime: shooter.lastReloadTime
        });

        const { dx, dy } = facingToDelta(shooter.facing || "down");
        if (dx === 0 && dy === 0) return;

        const startX = shooter.x + dx;
        const startY = shooter.y + dy;

        if (
            startX < 0 || startX >= GRID_W ||
            startY < 0 || startY >= GRID_H ||
            isWall(startX, startY) || isReflectWall(startX, startY) ||
            isCactusPos(room, startX, startY) // can't spawn inside solid
        ) {
            return;
        }

        const id = nextProjectileId++;

        // immediate hit check
        let hitId = null;
        for (const [pid, p] of Object.entries(room.players)) {
            if (p.hp > 0 && p.x === startX && p.y === startY) {
                hitId = pid;
                break;
            }
        }
        if (hitId) {
            const target = room.players[hitId];
            target.hp = Math.max(0, target.hp - 1);

            io.to(roomId).emit("projectileSpawn", { id, x: startX, y: startY, dx, dy });
            io.to(roomId).emit("projectileDestroy", { id, x: startX, y: startY });
            io.to(roomId).emit("healthUpdate", {
                hits: [{ id: hitId, hp: target.hp }]
            });
            handleRoundEndIfNeeded(roomId);
            return;
        }

        const proj = { id, x: startX, y: startY, dx, dy, shooterId: socket.id };
        room.projectiles.push(proj);
        io.to(roomId).emit("projectileSpawn", proj);
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = rooms[roomId];
        if (!room) return;

        if (room.players[socket.id]) {
            delete room.players[socket.id];
            socket.to(roomId).emit("playerLeft", { id: socket.id });
        }

        if (room.hostId === socket.id) {
            const remaining = Object.keys(room.players);
            room.hostId = remaining[0] || null;
            io.to(roomId).emit("hostUpdate", { hostId: room.hostId });
        }

        clearRoomTimers(room);
        clearProjectiles(roomId);

        if (!Object.keys(room.players).length) {
            delete rooms[roomId];
        } else if (room.state !== "waiting" && room.state !== "round_over") {
            room.state = "waiting";
            io.to(roomId).emit("roundState", {
                state: "waiting",
                hostId: room.hostId,
                cacti: room.cacti
            });
        }

        broadcastRoomsUpdate();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
