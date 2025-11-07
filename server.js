// server.js
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
const GRID_SIZE = 16;
const ATTACK_COOLDOWN = 3000; // ms
const MAX_PLAYERS_PER_ROOM = 2;

// Static walls shared across rooms
const WALLS = [
    { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 7, y: 8 },
    { x: 6, y: 7 }, { x: 8, y: 7 },

    { x: 2, y: 2 }, { x: 3, y: 2 }, { x: 4, y: 2 },
    { x: 2, y: 3 }, { x: 4, y: 3 },
    { x: 2, y: 4 }, { x: 3, y: 4 }, { x: 4, y: 4 },

    { x: 12, y: 4 }, { x: 12, y: 5 }, { x: 12, y: 6 }, { x: 12, y: 7 },

    { x: 5, y: 12 }, { x: 6, y: 12 }, { x: 7, y: 12 }
];

function isWall(x, y) {
    return WALLS.some(w => w.x === x && w.y === y);
}

// rooms[roomId] = {
//   players: { socketId: { x,y,color,name,hp,facing,lastAttackTime,score } },
//   state: 'waiting' | 'countdown' | 'playing' | 'round_over',
//   countdownTimeout: Timeout|null,
//   restartTimeout: Timeout|null
// }
const rooms = Object.create(null);

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
            state: "waiting",
            countdownTimeout: null,
            restartTimeout: null
        };
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

function isBlocked(roomId, x, y, ignoreId = null) {
    if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) return true;
    if (isWall(x, y)) return true;
    if (isTileBlockedByPlayer(roomId, x, y, ignoreId)) return true;
    return false;
}

function getRandomSpawn(roomId) {
    const room = rooms[roomId];
    if (!room) return { x: 0, y: 0 };

    for (let i = 0; i < 200; i++) {
        const x = Math.floor(Math.random() * GRID_SIZE);
        const y = Math.floor(Math.random() * GRID_SIZE);
        if (!isBlocked(roomId, x, y, null)) return { x, y };
    }

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            if (!isBlocked(roomId, x, y, null)) return { x, y };
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

// Wide attack: front + left + right
function getWideAttackTiles(p) {
    const f = p.facing || "down";
    const tiles = [];

    if (f === "up") {
        tiles.push(
            { x: p.x, y: p.y - 1 },
            { x: p.x - 1, y: p.y },
            { x: p.x + 1, y: p.y }
        );
    } else if (f === "down") {
        tiles.push(
            { x: p.x, y: p.y + 1 },
            { x: p.x + 1, y: p.y },
            { x: p.x - 1, y: p.y }
        );
    } else if (f === "left") {
        tiles.push(
            { x: p.x - 1, y: p.y },
            { x: p.x, y: p.y + 1 },
            { x: p.x, y: p.y - 1 }
        );
    } else if (f === "right") {
        tiles.push(
            { x: p.x + 1, y: p.y },
            { x: p.x, y: p.y - 1 },
            { x: p.x, y: p.y + 1 }
        );
    }

    return tiles.filter(t =>
        t.x >= 0 && t.x < GRID_SIZE && t.y >= 0 && t.y < GRID_SIZE
    );
}

// Long attack: up to 3 forward, blocked by walls/bounds
function getLongAttackTiles(p) {
    const { dx, dy } = facingToDelta(p.facing || "down");
    const tiles = [];
    let x = p.x;
    let y = p.y;

    for (let i = 0; i < 3; i++) {
        x += dx;
        y += dy;
        if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) break;
        if (isWall(x, y)) break;
        tiles.push({ x, y });
    }
    return tiles;
}

// --- ROUND / STATE MANAGEMENT ---

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

function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    clearRoomTimers(room);

    const ids = Object.keys(room.players);
    if (ids.length < 2) {
        room.state = "waiting";
        io.to(roomId).emit("roundState", { state: "waiting" });
        broadcastRoomsUpdate();
        return;
    }

    // Reset players (HP, positions, cooldown)
    ids.forEach(id => {
        const p = room.players[id];
        const spawn = getRandomSpawn(roomId);
        p.x = spawn.x;
        p.y = spawn.y;
        p.hp = 5;
        p.facing = "down";
        p.lastAttackTime = 0;
    });

    room.state = "countdown";
    io.to(roomId).emit("roundState", {
        state: "countdown",
        countdown: 3000,
        players: room.players
    });

    room.countdownTimeout = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        r.countdownTimeout = null;

        if (Object.keys(r.players).length < 2) {
            r.state = "waiting";
            io.to(roomId).emit("roundState", { state: "waiting" });
            broadcastRoomsUpdate();
            return;
        }

        r.state = "playing";
        io.to(roomId).emit("roundState", { state: "playing" });
    }, 3000);
}

function handleRoundEndIfNeeded(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "playing") return;

    const alive = Object.entries(room.players).filter(([, p]) => p.hp > 0);
    if (alive.length > 1) return;

    room.state = "round_over";
    clearRoomTimers(room);

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
        scores
    });

    room.restartTimeout = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        r.restartTimeout = null;
        startRound(roomId);
    }, 2000);
}

// --- SOCKET EVENTS ---

io.on("connection", (socket) => {
    socket.emit("roomsUpdate", getRoomsSummary());

    socket.on("joinRoom", ({ roomId, name }) => {
        roomId = String(roomId || "").trim() || "lobby";
        const room = ensureRoom(roomId);

        if (Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit("roomFull", { roomId });
            return;
        }

        socket.join(roomId);
        socket.data.roomId = roomId;

        const spawn = getRandomSpawn(roomId);
        const color = getColorForPlayer(roomId);

        const player = {
            x: spawn.x,
            y: spawn.y,
            color,
            name: name && name.trim() ? name.trim() : `Player-${socket.id.slice(0, 4)}`,
            hp: 5,
            facing: "down",
            lastAttackTime: 0,
            score: 0
        };

        room.players[socket.id] = player;

        socket.emit("currentState", {
            roomId,
            yourId: socket.id,
            players: room.players,
            walls: WALLS,
            gridSize: GRID_SIZE,
            state: room.state
        });

        socket.to(roomId).emit("playerJoined", {
            id: socket.id,
            player
        });

        broadcastRoomsUpdate();

        // If we just reached 2 players, start a round (3s countdown)
        if (Object.keys(room.players).length === 2) {
            startRound(roomId);
        }
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

        const fromX = player.x;
        const fromY = player.y;
        const toX = fromX + dx;
        const toY = fromY + dy;

        if (isBlocked(roomId, toX, toY, socket.id)) return;

        player.x = toX;
        player.y = toY;
        player.facing = facingFromDelta(dx, dy, player.facing);

        io.to(roomId).emit("playerMove", {
            id: socket.id,
            fromX,
            fromY,
            toX,
            toY,
            facing: player.facing
        });
    });

    socket.on("attack", ({ type }) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.state !== "playing") return;

        const attacker = room.players[socket.id];
        if (!attacker || attacker.hp <= 0) return;

        const now = Date.now();
        if (now - (attacker.lastAttackTime || 0) < ATTACK_COOLDOWN) {
            socket.emit("attackCooldown", {
                remaining: ATTACK_COOLDOWN - (now - attacker.lastAttackTime)
            });
            return;
        }

        let tiles = [];
        if (type === "wide") {
            tiles = getWideAttackTiles(attacker);
        } else if (type === "long") {
            tiles = getLongAttackTiles(attacker);
        } else {
            return;
        }

        attacker.lastAttackTime = now;

        const keySet = new Set(tiles.map(t => `${t.x},${t.y}`));
        const hitMap = {};

        for (const [id, p] of Object.entries(room.players)) {
            if (id === socket.id) continue;
            if (p.hp <= 0) continue;
            const key = `${p.x},${p.y}`;
            if (keySet.has(key)) {
                p.hp = Math.max(0, p.hp - 1);
                hitMap[id] = p.hp;
            }
        }

        io.to(roomId).emit("attackEvent", {
            attackerId: socket.id,
            type,
            tiles
        });

        if (Object.keys(hitMap).length > 0) {
            io.to(roomId).emit("healthUpdate", {
                hits: Object.entries(hitMap).map(([id, hp]) => ({ id, hp }))
            });
            handleRoundEndIfNeeded(roomId);
        }
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

        clearRoomTimers(room);

        const count = Object.keys(room.players).length;
        if (count === 0) {
            delete rooms[roomId];
        } else {
            room.state = "waiting";
            io.to(roomId).emit("roundState", { state: "waiting" });
        }

        broadcastRoomsUpdate();
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
