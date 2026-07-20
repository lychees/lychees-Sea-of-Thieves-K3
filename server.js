// ============================================================
// Sea of Rouge — multiplayer server (io-style)
// Serves static files + authoritative WebSocket game server:
// player state relay, cannonball simulation, OBB hit detection,
// damage / sinking / respawn, leaderboard snapshots.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const GRAVITY = 22;
const WORLD_SIZE = 1600;
const RESPAWN_MS = 3000;
const NEAR_MISS_RADIUS = 7;
const NEAR_MISS_DAMAGE = 6;

// ---------- Waves (must match client main.js) ----------
const WAVES = [
  { dx: 0.94388098, dy: 0.33035834, amp: 0.55, freq: 0.055, speed: 1.15 },
  { dx: -0.51449576, dy: 0.85749293, amp: 0.38, freq: 0.092, speed: 1.6 },
  { dx: 0.75257665, dy: -0.65850457, amp: 0.22, freq: 0.16, speed: 2.3 },
];
function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) {
    h += w.amp * Math.sin((x * w.dx + z * w.dy) * w.freq + t * w.speed);
  }
  return h;
}
const serverStart = Date.now();
const now = () => (Date.now() - serverStart) / 1000;

// ---------- OBB hit test (must match client main.js) ----------
function cannonballHitsShip(b, p) {
  const dx = b.x - p.x, dz = b.z - p.z;
  const c = Math.cos(p.heading), s = Math.sin(p.heading);
  const lx = dx * c - dz * s;   // along ship forward
  const lz = dx * s + dz * c;   // along ship beam
  const dy = b.y - (p.y || 0);
  const sc = p.scale || 1;
  return Math.abs(lx) < 5.4 * sc && Math.abs(lz) < 2.0 * sc && dy > -0.5 && dy < 4.5 * sc;
}

// ---------- Static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Game state ----------
const wss = new WebSocketServer({ server });
const players = new Map(); // id -> player record
const balls = [];          // server-side cannonballs (hit detection only)
let nextId = 1;

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === 1) p.ws.send(s);
  }
}

function damagePlayer(p, dmg, by, x, y, z) {
  if (p.dead) return;
  p.hp = Math.max(0, p.hp - dmg);
  broadcast({ t: 'hit', target: p.id, hp: p.hp, by, x, y, z });
  if (p.hp <= 0) {
    p.dead = true;
    broadcast({ t: 'sink', id: p.id, by, x: p.x, z: p.z });
    setTimeout(() => {
      if (!players.has(p.id)) return;
      const a = Math.random() * Math.PI * 2;
      p.x = Math.cos(a) * 200;
      p.z = Math.sin(a) * 200;
      p.hp = p.maxHp;
      p.dead = false;
      broadcast({ t: 'respawn', id: p.id, x: p.x, z: p.z, hp: p.hp });
    }, RESPAWN_MS);
  }
}

wss.on('connection', ws => {
  let me = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join' && !me) {
      const id = nextId++;
      const a = Math.random() * Math.PI * 2;
      me = {
        ws, id,
        name: String(msg.name || 'Pirate').slice(0, 12),
        x: Math.cos(a) * 150, y: 0, z: Math.sin(a) * 150,
        heading: 0, speed: 0, sailLevel: 0,
        gold: 0, sunk: 0,
        cls: 0, scale: 0.85, cannons: 2,
        hp: 80, maxHp: 80,
        dead: false,
      };
      players.set(id, me);
      ws.send(JSON.stringify({ t: 'welcome', id, x: me.x, z: me.z }));
      console.log(`[join] #${id} ${me.name} (${players.size} online)`);
      return;
    }
    if (!me) return;

    if (msg.t === 'state') {
      me.x = +msg.x || 0;
      me.y = +msg.y || 0;
      me.z = +msg.z || 0;
      me.heading = +msg.heading || 0;
      me.speed = +msg.speed || 0;
      me.sailLevel = msg.sailLevel | 0;
      me.gold = Math.max(0, msg.gold | 0);
      me.sunk = Math.max(0, msg.sunk | 0);
      me.cls = msg.cls | 0;
      me.scale = +msg.scale || 1;
      me.cannons = msg.cannons | 0;
      const newMax = Math.max(1, msg.maxHp | 0);
      if (newMax !== me.maxHp) { me.maxHp = newMax; me.hp = newMax; } // class/upgrade change heals
    } else if (msg.t === 'fire' && Array.isArray(msg.balls) && !me.dead) {
      const damage = Math.min(100, Math.max(1, msg.damage | 0));
      for (const b of msg.balls.slice(0, 12)) {
        balls.push({
          x: +b.x, y: +b.y, z: +b.z,
          vx: +b.vx, vy: +b.vy, vz: +b.vz,
          owner: me.id, damage, life: 6,
        });
      }
      // relay to other clients so they can render the volley
      broadcast({ t: 'fire', owner: me.id, balls: msg.balls.slice(0, 12) });
    }
  });

  ws.on('close', () => {
    if (me) {
      players.delete(me.id);
      console.log(`[leave] #${me.id} ${me.name} (${players.size} online)`);
    }
  });
});

// ---------- Cannonball simulation (30 Hz) ----------
setInterval(() => {
  const dt = 1 / 30;
  const t = now();
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.life -= dt;
    b.vy -= GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    // water impact -> near-miss splash damage
    if (b.y <= waveHeight(b.x, b.z, t)) {
      for (const p of players.values()) {
        if (p.id === b.owner || p.dead) continue;
        const d = Math.hypot(p.x - b.x, p.z - b.z);
        if (d < NEAR_MISS_RADIUS * (p.scale || 1)) {
          damagePlayer(p, NEAR_MISS_DAMAGE, b.owner, b.x, b.y, b.z);
        }
      }
      balls.splice(i, 1);
      continue;
    }
    if (b.life <= 0) { balls.splice(i, 1); continue; }

    // direct OBB hit
    for (const p of players.values()) {
      if (p.id === b.owner || p.dead) continue;
      if (cannonballHitsShip(b, p)) {
        damagePlayer(p, b.damage, b.owner, b.x, b.y, b.z);
        balls.splice(i, 1);
        break;
      }
    }
  }
}, 1000 / 30);

// ---------- Snapshots (10 Hz) ----------
setInterval(() => {
  if (players.size === 0) return;
  const list = [...players.values()].map(p => ({
    id: p.id, name: p.name,
    x: +p.x.toFixed(2), z: +p.z.toFixed(2), heading: +p.heading.toFixed(3),
    speed: +p.speed.toFixed(2), sailLevel: p.sailLevel,
    gold: p.gold, sunk: p.sunk,
    cls: p.cls, scale: p.scale, cannons: p.cannons,
    hp: p.hp, maxHp: p.maxHp, dead: p.dead,
  }));
  broadcast({ t: 'snap', players: list });
}, 100);

server.listen(PORT, () => {
  console.log(`🏴‍☠️  Sea of Rouge server: http://localhost:${PORT}`);
});
