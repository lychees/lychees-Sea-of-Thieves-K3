import * as THREE from 'three';

// ============================================================
// Sea of Rouge — a Sea of Thieves-inspired three.js game
// Solo mode vs AI ships, or io-style WebSocket multiplayer.
// ============================================================

// ---------- Config ----------
const WORLD_SIZE = 1600;          // playable radius
const WORLD_SEED = 20260720;      // fixed seed: all MP clients share the same world
const ISLAND_COUNT = 7;
const ENEMY_COUNT = 3;
const GRAVITY = 22;
const CANNON_SPEED = 55;
const CANNON_COOLDOWN = 1.4;
const ENEMY_MAX_HP = 60;
const ENEMY_CANNON_DAMAGE = 20;
const NEAR_MISS_RADIUS = 7;       // splash damage radius for water impacts
const NEAR_MISS_DAMAGE = 6;

// ---------- Seeded RNG (world generation must match across clients) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(WORLD_SEED);

// ---------- Waves (shared between GLSL and JS; mirrored in server.js) ----------
const WAVES = [
  { dir: new THREE.Vector2(1.0, 0.35).normalize(), amp: 0.55, freq: 0.055, speed: 1.15 },
  { dir: new THREE.Vector2(-0.6, 1.0).normalize(), amp: 0.38, freq: 0.092, speed: 1.6 },
  { dir: new THREE.Vector2(0.8, -0.7).normalize(), amp: 0.22, freq: 0.16, speed: 2.3 },
];

function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) {
    h += w.amp * Math.sin((x * w.dir.x + z * w.dir.y) * w.freq + t * w.speed);
  }
  return h;
}

// GLSL version generated from the same constants
const WAVE_GLSL = WAVES.map(w => `
  h += ${w.amp.toFixed(3)} * sin((p.x * ${w.dir.x.toFixed(5)} + p.z * ${w.dir.y.toFixed(5)}) * ${w.freq.toFixed(4)} + uTime * ${w.speed.toFixed(3)});
`).join('');

// ---------- OBB hit test for cannonballs (mirrored in server.js) ----------
function cannonballHitsShip(p, ship) {
  const dx = p.x - ship.pos.x, dz = p.z - ship.pos.z;
  const c = Math.cos(ship.heading), s = Math.sin(ship.heading);
  const lx = dx * c - dz * s;   // along ship forward
  const lz = dx * s + dz * c;   // along ship beam
  const dy = p.y - ship.pos.y;
  const sc = ship.shipScale;
  return Math.abs(lx) < 5.4 * sc && Math.abs(lz) < 2.0 * sc && dy > -0.5 && dy < 4.5 * sc;
}

// ---------- Renderer / Scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fc4d8, 120, 900);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3000);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- Sky, sun, lights ----------
const sunDir = new THREE.Vector3(0.45, 0.55, 0.35).normalize();

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2400, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uSun: { value: sunDir } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 uSun;
      void main() {
        float y = clamp(vDir.y, -0.1, 1.0);
        vec3 horizon = vec3(0.85, 0.72, 0.55);
        vec3 mid     = vec3(0.45, 0.66, 0.82);
        vec3 zenith  = vec3(0.12, 0.30, 0.55);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.25, y));
        col = mix(col, zenith, smoothstep(0.25, 0.9, y));
        float s = max(dot(vDir, uSun), 0.0);
        col += vec3(1.0, 0.85, 0.55) * pow(s, 350.0) * 2.0;  // sun disc
        col += vec3(1.0, 0.7, 0.4) * pow(s, 8.0) * 0.25;     // glow
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
);
scene.add(sky);

const hemi = new THREE.HemisphereLight(0xbfd9ea, 0x2a3b2f, 0.75);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffe6b8, 1.6);
sun.position.copy(sunDir).multiplyScalar(300);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
sun.shadow.camera.far = 700;
scene.add(sun);
scene.add(sun.target);

// ---------- Ocean ----------
const oceanUniforms = {
  uTime: { value: 0 },
  uSun: { value: sunDir },
  fogColor: { value: scene.fog.color },
  fogNear: { value: scene.fog.near },
  fogFar: { value: scene.fog.far },
};

const ocean = new THREE.Mesh(
  new THREE.PlaneGeometry(6000, 6000, 220, 220).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    uniforms: oceanUniforms,
    vertexShader: `
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFogDepth;

      float waveH(vec2 xz) {
        vec3 p = vec3(xz.x, 0.0, xz.y);
        float h = 0.0;
        ${WAVE_GLSL}
        return h;
      }

      void main() {
        vec3 pos = position;
        vec4 wp = modelMatrix * vec4(pos, 1.0);
        float h = waveH(wp.xz);
        wp.y += h;
        // finite-difference normal
        float e = 1.2;
        float hx = waveH(wp.xz + vec2(e, 0.0)) - h;
        float hz = waveH(wp.xz + vec2(0.0, e)) - h;
        vNormal = normalize(vec3(-hx / e, 1.0, -hz / e));
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vFogDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uSun;
      uniform vec3 fogColor;
      uniform float fogNear;
      uniform float fogFar;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFogDepth;

      void main() {
        vec3 deep = vec3(0.015, 0.10, 0.19);
        vec3 shallow = vec3(0.05, 0.28, 0.36);
        vec3 col = mix(deep, shallow, clamp(vWorld.y * 0.6 + 0.45, 0.0, 1.0));

        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 3.0);
        col = mix(col, vec3(0.55, 0.70, 0.80), fres * 0.55);

        // sun specular
        vec3 hv = normalize(viewDir + uSun);
        float spec = pow(max(dot(vNormal, hv), 0.0), 220.0);
        col += vec3(1.0, 0.85, 0.6) * spec * 1.4;

        // foam on crests
        float foam = smoothstep(0.75, 1.05, vWorld.y);
        col = mix(col, vec3(0.85, 0.92, 0.94), foam * 0.5);

        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
        col = mix(col, fogColor, fogF);
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
);
scene.add(ocean);

// ---------- Materials ----------
const MAT = {
  hullDark: new THREE.MeshStandardMaterial({ color: 0x3c2716, roughness: 0.9 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 }),
  mast: new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.85 }),
  sail: new THREE.MeshStandardMaterial({ color: 0xe8ddc0, roughness: 0.95, side: THREE.DoubleSide }),
  sailEnemy: new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.95, side: THREE.DoubleSide }),
  sailRemote: new THREE.MeshStandardMaterial({ color: 0x9fd7ff, roughness: 0.95, side: THREE.DoubleSide }),
  cannon: new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.5, metalness: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.3, metalness: 0.8, emissive: 0x664400 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xd9c08a, roughness: 1 }),
  grass: new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 1 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 1 }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 1, side: THREE.DoubleSide }),
  flag: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1, side: THREE.DoubleSide }),
};

// ---------- Ship models ----------
// Per-class hull configs: every ship class gets its own distinct model.
const HULL_CONFIGS = {
  sloop: {
    len: 9, beam: 3.0, h: 2.0, color: 0x6a452a,
    masts: [{ x: 0.8, h: 8, sailW: 4.2, sailH: 4.4 }],
    stern: { w: 1.8, h: 1.0, d: 2.4 }, fore: null, gunDecks: 1,
  },
  brig: {
    len: 10, beam: 3.2, h: 2.2, color: 0x5a3a22,
    masts: [{ x: 1.6, h: 8.5, sailW: 4.6, sailH: 4.2 }, { x: -2.2, h: 7, sailW: 3.8, sailH: 3.4 }],
    stern: { w: 2.2, h: 1.4, d: 2.8 }, fore: null, gunDecks: 1,
  },
  galleon: {
    len: 12, beam: 3.8, h: 2.6, color: 0x6b4226,
    masts: [{ x: 3.2, h: 9.5, sailW: 5.0, sailH: 4.6 }, { x: 0, h: 10.5, sailW: 5.4, sailH: 5.0 }, { x: -3.6, h: 8, sailW: 4.2, sailH: 3.8 }],
    stern: { w: 2.8, h: 2.6, d: 3.2 }, fore: { w: 1.8, h: 1.3, d: 2.8 }, gunDecks: 1,
  },
  manowar: {
    len: 13, beam: 4.2, h: 2.8, color: 0x3a2a1e,
    masts: [{ x: 3.6, h: 10, sailW: 5.4, sailH: 4.8 }, { x: 0, h: 11, sailW: 5.8, sailH: 5.4 }, { x: -4, h: 8.6, sailW: 4.6, sailH: 4.0 }],
    stern: { w: 3.0, h: 2.4, d: 3.4 }, fore: { w: 2.0, h: 1.5, d: 3.0 }, gunDecks: 2,
  },
};

// tapered hull extruded from a ship-outline shape
function makeHullGeo(len, beam, h) {
  const L = len / 2, B = beam / 2;
  const s = new THREE.Shape();
  s.moveTo(-L, 0);
  s.lineTo(-L * 0.75, B);
  s.lineTo(L * 0.57, B);
  s.quadraticCurveTo(L * 0.93, B * 0.55, L, 0);
  s.quadraticCurveTo(L * 0.93, -B * 0.55, L * 0.57, -B);
  s.lineTo(-L * 0.75, -B);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // shape XY -> XZ, extrude becomes height
  g.translate(0, h, 0);
  return g;
}

function makeCurvedSail(w, h, mat) {
  const geo = new THREE.PlaneGeometry(w, h, 8, 4);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setZ(i, Math.cos((y / h) * Math.PI * 0.5) * 0.9);
  }
  geo.computeVertexNormals();
  const sail = new THREE.Mesh(geo, mat);
  sail.rotation.y = Math.PI / 2;
  sail.castShadow = true;
  return sail;
}

const cannonGeo = new THREE.CylinderGeometry(0.16, 0.2, 1.4);
cannonGeo.rotateX(Math.PI / 2);

// 排船 — a tiny log raft with a single square sail
function buildRaft({ enemy = false, remote = false, scale = 1 } = {}) {
  const g = new THREE.Group();

  // logs
  const logGeo = new THREE.CylinderGeometry(0.32, 0.32, 6, 8);
  logGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const log = new THREE.Mesh(logGeo, MAT.trunk);
    log.position.set(0, 0.35, -1.3 + i * 0.65);
    log.castShadow = true;
    g.add(log);
  }
  // cross beams
  for (const bx of [-2, 2]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.25, 3.2), MAT.mast);
    beam.position.set(bx, 0.68, 0);
    g.add(beam);
  }
  // mast + square sail
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 5.2), MAT.mast);
  mast.position.set(0.3, 3.1, 0);
  mast.castShadow = true;
  g.add(mast);
  const sailMat = enemy ? MAT.sailEnemy : (remote ? MAT.sailRemote : MAT.sail);
  const sail = makeCurvedSail(2.8, 2.6, sailMat);
  sail.position.set(0.15, 3.6, 0);
  g.add(sail);
  const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2), MAT.mast);
  yard.rotation.x = Math.PI / 2;
  yard.position.set(0.15, 4.9, 0);
  g.add(yard);
  // single mounted cannon
  const cannon = new THREE.Mesh(cannonGeo, MAT.cannon);
  cannon.rotation.y = Math.PI / 2;
  cannon.position.set(1.8, 0.95, 0);
  g.add(cannon);
  // tiller stick at the back
  const tiller = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6), MAT.mast);
  tiller.rotation.z = Math.PI / 2.6;
  tiller.position.set(-2.8, 1.1, 0);
  g.add(tiller);

  g.scale.setScalar(scale);
  g.userData.sails = [sail];
  g.userData.cannonXs = [0];
  g.userData.fireY = 1.0;
  return g;
}

// generic sailing ship built from a hull config
function buildSailShip(cfg, { enemy = false, remote = false, cannons = 3, scale = 1 } = {}) {
  const ship = new THREE.Group();
  const { len, beam, h } = cfg;

  const hullMat = new THREE.MeshStandardMaterial({ color: cfg.color, roughness: 0.85 });
  const hull = new THREE.Mesh(makeHullGeo(len, beam, h), hullMat);
  hull.castShadow = true;
  ship.add(hull);

  // deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(len * 0.86, 0.15, beam * 0.9), MAT.deck);
  deck.position.set(-len * 0.02, h + 0.05, 0);
  ship.add(deck);

  // stern castle
  if (cfg.stern) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(cfg.stern.w, cfg.stern.h, cfg.stern.d), MAT.hullDark);
    st.position.set(-len / 2 + cfg.stern.w / 2 + 0.4, h + cfg.stern.h / 2, 0);
    st.castShadow = true;
    ship.add(st);
  }
  // forecastle
  if (cfg.fore) {
    const fc = new THREE.Mesh(new THREE.BoxGeometry(cfg.fore.w, cfg.fore.h, cfg.fore.d), hullMat);
    fc.position.set(len / 2 - cfg.fore.w / 2 - 0.9, h + cfg.fore.h / 2, 0);
    fc.castShadow = true;
    ship.add(fc);
  }

  // bowsprit
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, len * 0.3), MAT.mast);
  bowsprit.rotation.z = -Math.PI / 2 + 0.35;
  bowsprit.position.set(len / 2 + len * 0.12, h + 0.7, 0);
  ship.add(bowsprit);

  // masts + sails
  const sailMat = enemy ? MAT.sailEnemy : (remote ? MAT.sailRemote : MAT.sail);
  const sails = [];
  let mainMast = cfg.masts[0];
  for (const md of cfg.masts) {
    if (md.h > mainMast.h) mainMast = md;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, md.h), MAT.mast);
    mast.position.set(md.x, h + md.h / 2, 0);
    mast.castShadow = true;
    ship.add(mast);

    const sail = makeCurvedSail(md.sailW, md.sailH, sailMat);
    sail.position.set(md.x - 0.15, h + md.h * 0.55, 0);
    ship.add(sail);
    sails.push(sail);

    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, md.sailW + 0.6), MAT.mast);
    yard.rotation.x = Math.PI / 2;
    yard.position.set(md.x - 0.15, h + md.h * 0.55 + md.sailH / 2, 0);
    ship.add(yard);
  }

  // flag on the tallest mast
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8), MAT.flag);
  flag.position.set(mainMast.x, h + mainMast.h + 0.4, 0.7);
  ship.add(flag);

  // cannons on both broadsides (deck row)
  const cannonXs = cannons === 1 ? [0]
    : Array.from({ length: cannons }, (_, i) => -len * 0.22 + (i * len * 0.47) / (cannons - 1));
  for (const side of [-1, 1]) {
    for (const cx of cannonXs) {
      const c = new THREE.Mesh(cannonGeo, MAT.cannon);
      c.position.set(cx, h - 0.1, side * (beam / 2 - 0.05));
      ship.add(c);
    }
  }
  // second gun deck (visual only) for ships of the line
  if (cfg.gunDecks > 1) {
    for (const side of [-1, 1]) {
      for (const cx of cannonXs) {
        const c = new THREE.Mesh(cannonGeo, MAT.cannon);
        c.position.set(cx + len * 0.05, h * 0.45, side * (beam / 2 + 0.25));
        ship.add(c);
      }
    }
  }

  ship.scale.setScalar(scale);
  ship.userData.sails = sails;
  ship.userData.cannonXs = cannonXs;
  ship.userData.fireY = h - 0.1;
  return ship;
}

function buildShip({ type = 'brig', enemy = false, remote = false, cannons = 3, scale = 1 } = {}) {
  if (type === 'raft') return buildRaft({ enemy, remote, scale });
  return buildSailShip(HULL_CONFIGS[type] || HULL_CONFIGS.brig, { enemy, remote, cannons, scale });
}

// ---------- Ship entity ----------
class Ship {
  constructor({ enemy = false, remote = false, type = 'brig', x = 0, z = 0, heading = 0,
                cannons = 3, scale = 1, speedMult = 1, turnMult = 1, cannonDamage = 20, maxHp = 100 } = {}) {
    this.enemy = enemy;
    this.remote = remote;
    this.type = type;
    this.shipScale = scale;
    this.speedMult = speedMult;
    this.turnMult = turnMult;
    this.cannonDamage = cannonDamage;
    this.mesh = buildShip({ type, enemy, remote, cannons, scale });
    this.mesh.position.set(x, 0, z);
    this.heading = heading;
    this.speed = 0;
    this.sailLevel = 0;          // 0..3
    this.turnInput = 0;
    this.hp = maxHp;
    this.maxHp = maxHp;
    this.cooldown = 0;
    this.sinking = 0;            // >0 while sinking
    this.dead = false;
    this.lastFired = [];         // cannonballs of the most recent volley
    // enemy AI
    this.aiTimer = 0;
    this.aiTurn = 0;
    scene.add(this.mesh);
  }

  get pos() { return this.mesh.position; }

  rebuild({ cannons, scale, type = this.type }) {
    const pos = this.pos.clone();
    scene.remove(this.mesh);
    this.type = type;
    this.mesh = buildShip({ type, enemy: this.enemy, remote: this.remote, cannons, scale });
    this.mesh.position.copy(pos);
    this.shipScale = scale;
    scene.add(this.mesh);
  }

  update(dt, t) {
    if (this.dead) return;

    if (this.sinking > 0) {
      this.sinking += dt;
      this.mesh.position.y = -this.sinking * 1.6;
      this.mesh.rotation.z += dt * 0.25;
      this.mesh.rotation.x += dt * 0.1;
      if (this.sinking > 4) {
        this.dead = true;
        scene.remove(this.mesh);
      }
      return;
    }

    // sailing physics
    const targetSpeed = this.sailLevel * 4.2 * this.speedMult;
    this.speed += (targetSpeed - this.speed) * Math.min(1, dt * 0.5);
    const turnRate = 0.45 * this.turnMult * Math.min(1, this.speed / 4 + 0.25);
    this.heading += this.turnInput * turnRate * dt;

    const dirX = Math.cos(this.heading);
    const dirZ = -Math.sin(this.heading);
    this.pos.x += dirX * this.speed * dt;
    this.pos.z += dirZ * this.speed * dt;

    // keep inside world
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD_SIZE) {
      const push = (r - WORLD_SIZE) / r;
      this.pos.x -= this.pos.x * push;
      this.pos.z -= this.pos.z * push;
      this.heading += Math.PI * dt; // turn around
    }

    this.applyWaveRide(t);
    this.updateSailVisual(dt);

    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  applyWaveRide(t) {
    const dirX = Math.cos(this.heading);
    const dirZ = -Math.sin(this.heading);
    const px = this.pos.x, pz = this.pos.z;
    const bow = waveHeight(px + dirX * 4, pz + dirZ * 4, t);
    const sternH = waveHeight(px - dirX * 4, pz - dirZ * 4, t);
    const port = waveHeight(px + dirZ * 2, pz - dirX * 2, t);
    const star = waveHeight(px - dirZ * 2, pz + dirX * 2, t);
    this.pos.y = (bow + sternH + port + star) / 4;
    const pitch = Math.atan2(sternH - bow, 8);
    const roll = Math.atan2(port - star, 4);
    this.mesh.rotation.set(0, this.heading, 0);
    this.mesh.rotateX(roll * 0.7);
    this.mesh.rotateZ(pitch * 0.7);
  }

  updateSailVisual(dt) {
    const sailScale = 0.25 + (this.sailLevel / 3) * 0.75;
    for (const s of this.mesh.userData.sails) {
      s.scale.y += (sailScale - s.scale.y) * Math.min(1, dt * 3);
    }
  }

  fireBroadside(cannonballs, power = 1) {
    if (this.cooldown > 0 || this.sinking > 0 || this.dead) return false;
    this.cooldown = CANNON_COOLDOWN;
    this.lastFired.length = 0;
    const dirX = Math.cos(this.heading);
    const dirZ = -Math.sin(this.heading);
    const fireY = this.mesh.userData.fireY || 2.2;
    // fire from both sides
    for (const side of [-1, 1]) {
      for (const cx of this.mesh.userData.cannonXs) {
        const ox = (cx * dirX + side * 1.8 * dirZ) * this.shipScale;
        const oz = (-cx * dirZ + side * 1.8 * dirX) * this.shipScale;
        const vel = new THREE.Vector3(side * dirZ, 0.28, -side * dirX).normalize()
          .multiplyScalar(CANNON_SPEED * power * (0.92 + Math.random() * 0.16));
        vel.x += dirX * this.speed;
        vel.z += dirZ * this.speed;
        const cb = new Cannonball(
          this.pos.x + ox, this.pos.y + fireY, this.pos.z + oz, vel, this
        );
        cannonballs.push(cb);
        this.lastFired.push(cb);
      }
    }
    spawnMuzzleFlash(this);
    return true;
  }

  damage(n) {
    if (this.sinking > 0 || this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.hp = 0;
      this.sinking = 0.001;
    }
  }
}

// ---------- Cannonballs ----------
const ballGeo = new THREE.SphereGeometry(0.28, 10, 8);
const ballMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.4, metalness: 0.6 });

class Cannonball {
  constructor(x, y, z, vel, owner) {
    this.mesh = new THREE.Mesh(ballGeo, ballMat);
    this.mesh.position.set(x, y, z);
    this.vel = vel;
    this.owner = owner;
    this.life = 6;
    scene.add(this.mesh);
  }
  // returns true while flying, 'water' on splash, 'expired' on timeout
  update(dt, t) {
    this.life -= dt;
    this.vel.y -= GRAVITY * dt;
    this.mesh.position.addScaledVector(this.vel, dt);
    const p = this.mesh.position;
    if (p.y <= waveHeight(p.x, p.z, t)) {
      spawnSplash(p.x, p.z, t);
      return 'water';
    }
    return this.life > 0 ? true : 'expired';
  }
}

// ---------- Particles (splashes, flashes, hits) ----------
const particles = [];
const splashGeo = new THREE.SphereGeometry(0.35, 6, 5);
const splashMat = new THREE.MeshBasicMaterial({ color: 0xdff2f8, transparent: true });

function spawnSplash(x, z, t) {
  const y = waveHeight(x, z, t);
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(splashGeo, splashMat.clone());
    m.position.set(x, y + 0.2, z);
    const a = Math.random() * Math.PI * 2;
    particles.push({
      mesh: m, life: 0.7 + Math.random() * 0.3, age: 0,
      vel: new THREE.Vector3(Math.cos(a) * 3, 5 + Math.random() * 4, Math.sin(a) * 3),
      grav: 14, shrink: true,
    });
    scene.add(m);
  }
}

function spawnHitEffect(x, y, z) {
  for (let i = 0; i < 12; i++) {
    const hot = i % 2 === 0;
    const m = new THREE.Mesh(splashGeo, new THREE.MeshBasicMaterial({
      color: hot ? 0xff8844 : 0x3a2a1a, transparent: true,
    }));
    m.position.set(x, y, z);
    const a = Math.random() * Math.PI * 2;
    particles.push({
      mesh: m, life: 0.5 + Math.random() * 0.35, age: 0,
      vel: new THREE.Vector3(Math.cos(a) * 6, 3 + Math.random() * 5, Math.sin(a) * 6),
      grav: 12, shrink: true,
    });
    scene.add(m);
  }
}

function spawnMuzzleFlash(ship) {
  const dirX = Math.cos(ship.heading), dirZ = -Math.sin(ship.heading);
  const fireY = ship.mesh.userData.fireY || 2.2;
  for (const side of [-1, 1]) {
    for (const cx of ship.mesh.userData.cannonXs) {
      const m = new THREE.Mesh(splashGeo, new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true }));
      m.position.set(
        ship.pos.x + (cx * dirX + side * 2.4 * dirZ) * ship.shipScale,
        ship.pos.y + fireY,
        ship.pos.z + (-cx * dirZ + side * 2.4 * dirX) * ship.shipScale
      );
      particles.push({
        mesh: m, life: 0.25, age: 0,
        vel: new THREE.Vector3(side * dirZ * 8, 1, -side * dirX * 8),
        grav: 0, shrink: true,
      });
      scene.add(m);
    }
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.age += dt;
    if (p.age >= p.life) {
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.vel.y -= p.grav * dt;
    p.mesh.position.addScaledVector(p.vel, dt);
    const k = 1 - p.age / p.life;
    p.mesh.material.opacity = k;
    if (p.shrink) p.mesh.scale.setScalar(Math.max(0.05, k));
  }
}

// ---------- Islands ----------
const islands = []; // {x, z, r, group, isPort, treasure}

function buildIsland(x, z, r) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  // sandy base
  const base = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.75, r, 4, 24), MAT.sand);
  base.position.y = -0.5;
  base.receiveShadow = true;
  g.add(base);

  // grassy mound
  const mound = new THREE.Mesh(new THREE.ConeGeometry(r * 0.62, r * 0.55, 20), MAT.grass);
  mound.position.y = 1.5 + r * 0.22;
  mound.castShadow = true;
  mound.receiveShadow = true;
  g.add(mound);

  // a rock or two
  for (let i = 0; i < 2; i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.1 + rng() * r * 0.06), MAT.rock);
    const a = rng() * Math.PI * 2;
    rock.position.set(Math.cos(a) * r * 0.5, 1.2, Math.sin(a) * r * 0.5);
    rock.castShadow = true;
    g.add(rock);
  }

  // palm trees
  const palms = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < palms; i++) {
    const palm = new THREE.Group();
    const a = rng() * Math.PI * 2;
    const pr = r * (0.25 + rng() * 0.3);
    palm.position.set(Math.cos(a) * pr, 1.5, Math.sin(a) * pr);
    const lean = (rng() - 0.5) * 0.5;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.3, 6, 6), MAT.trunk);
    trunk.position.y = 3;
    trunk.rotation.z = lean;
    trunk.castShadow = true;
    palm.add(trunk);
    const topX = -Math.sin(lean) * 6, topY = Math.cos(lean) * 6;
    for (let l = 0; l < 6; l++) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.1), MAT.leaf);
      const la = (l / 6) * Math.PI * 2;
      leaf.position.set(topX + Math.cos(la) * 1.6, topY + 0.2, Math.sin(la) * 1.6);
      leaf.rotation.y = -la;
      leaf.rotation.z = -0.45;
      leaf.castShadow = true;
      palm.add(leaf);
    }
    g.add(palm);
  }

  scene.add(g);
  return { x, z, r, group: g, isPort: false, treasure: null };
}

// ---------- Port ----------
function buildPort(x, z) {
  const isl = buildIsland(x, z, 34);
  isl.isPort = true;
  const g = isl.group;
  const r = isl.r;

  // wooden pier reaching out to sea
  const pier = new THREE.Mesh(new THREE.BoxGeometry(18, 0.4, 3), MAT.deck);
  pier.position.set(r * 0.95, 2.0, 0);
  pier.castShadow = true;
  g.add(pier);
  for (let i = 0; i < 4; i++) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2.6), MAT.mast);
    post.position.set(r * 0.95 - 7 + i * 4.5, 0.9, 1.2 * (i % 2 ? 1 : -1));
    g.add(post);
  }

  // tavern + warehouse with pyramid roofs
  const hutDefs = [
    { x: -6, z: 9, w: 6, h: 4, d: 5, c: 0x7a5230 },
    { x: 8, z: -7, w: 5, h: 3.4, d: 4, c: 0x8a6242 },
  ];
  for (const hd of hutDefs) {
    const hut = new THREE.Mesh(
      new THREE.BoxGeometry(hd.w, hd.h, hd.d),
      new THREE.MeshStandardMaterial({ color: hd.c, roughness: 0.9 })
    );
    hut.position.set(hd.x, 1.5 + hd.h / 2, hd.z);
    hut.castShadow = true;
    g.add(hut);
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(hd.w, hd.d) * 0.78, 2.2, 4),
      new THREE.MeshStandardMaterial({ color: 0x4a2c1a, roughness: 1 })
    );
    roof.position.set(hd.x, 1.5 + hd.h + 1.1, hd.z);
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
  }

  // warm lantern light
  const lamp = new THREE.PointLight(0xffb347, 1.4, 70);
  lamp.position.set(0, 9, 0);
  g.add(lamp);

  return isl;
}

const port = buildPort(120, 120);
islands.push(port);

// scatter islands with minimum separation (avoiding the port)
function scatterIslands() {
  let attempts = 0;
  while (islands.length < ISLAND_COUNT + 1 && attempts++ < 500) {
    const a = rng() * Math.PI * 2;
    const d = 220 + rng() * (WORLD_SIZE - 350);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const r = 26 + rng() * 22;
    if (islands.every(p => Math.hypot(p.x - x, p.z - z) > p.r + r + 160)) {
      islands.push(buildIsland(x, z, r));
    }
  }
}
scatterIslands();

// ---------- Treasure ----------
const chestGeo = new THREE.BoxGeometry(1.4, 0.9, 0.9);
const chestLidGeo = new THREE.BoxGeometry(1.4, 0.35, 0.9);
const xMarkMat = new THREE.MeshBasicMaterial({ color: 0xff3b30 });

function spawnTreasure(island) {
  if (island.treasure) {
    scene.remove(island.treasure.group);
  }
  const a = rng() * Math.PI * 2;
  const d = island.r * 0.7; // near the shore so the ship can get close enough
  const tx = island.x + Math.cos(a) * d;
  const tz = island.z + Math.sin(a) * d;

  const g = new THREE.Group();
  g.position.set(tx, 1.6, tz);

  // X mark: two crossed bars
  const bar1 = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.4), xMarkMat);
  bar1.rotation.y = Math.PI / 4;
  const bar2 = bar1.clone();
  bar2.rotation.y = -Math.PI / 4;
  g.add(bar1, bar2);

  // hidden chest (revealed on dig)
  const chest = new THREE.Group();
  const body = new THREE.Mesh(chestGeo, MAT.hullDark);
  const lid = new THREE.Mesh(chestLidGeo, MAT.gold);
  lid.position.y = 0.6;
  chest.add(body, lid);
  chest.visible = false;
  chest.position.y = -0.4;
  g.add(chest);

  scene.add(g);
  island.treasure = { group: g, chest, x: tx, z: tz, active: true, dug: false };
}

for (const isl of islands) if (!isl.isPort) spawnTreasure(isl);

// ---------- Extraction point ----------
const extraction = (() => {
  const a = rng() * Math.PI * 2;
  const d = WORLD_SIZE * 0.75;
  const x = Math.cos(a) * d, z = Math.sin(a) * d;
  const g = new THREE.Group();
  g.position.set(x, 0, z);

  // vertical light beam
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.5, 4, 140, 16, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x7fe7ff, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = 70;
  g.add(beam);

  // glowing buoy ring on the water
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(14, 0.6, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0x7fe7ff })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.5;
  g.add(ring);

  const light = new THREE.PointLight(0x7fe7ff, 1.6, 140);
  light.position.y = 10;
  g.add(light);

  scene.add(g);
  return { x, z, group: g, ring, beam };
})();

// ---------- Entities ----------
const player = new Ship({
  type: 'sloop', x: 0, z: 0, heading: Math.PI / 2,
  cannons: 2, scale: 0.85, speedMult: 1.15, turnMult: 1.2, cannonDamage: 20, maxHp: 80,
});
const enemies = [];
const cannonballs = [];

function spawnEnemy() {
  const a = Math.random() * Math.PI * 2;
  const d = 300 + Math.random() * 500;
  const e = new Ship({
    enemy: true, type: 'brig',
    x: player.pos.x + Math.cos(a) * d,
    z: player.pos.z + Math.sin(a) * d,
    heading: Math.random() * Math.PI * 2,
    cannons: 3, scale: 1, speedMult: 1, cannonDamage: ENEMY_CANNON_DAMAGE, maxHp: ENEMY_MAX_HP,
  });
  e.sailLevel = 2;
  enemies.push(e);
}

// ---------- Floating loot (dropped by sunk ships, picked up into the hold) ----------
const floatingLoot = []; // {mesh, value, phase}
const lootBodyGeo = new THREE.BoxGeometry(1.2, 0.7, 0.8);

function spawnFloatingLoot(x, z, value) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(lootBodyGeo, MAT.hullDark);
  const lid = new THREE.Mesh(chestLidGeo, MAT.gold);
  lid.scale.set(0.85, 1, 0.9);
  lid.position.y = 0.5;
  g.add(body, lid);
  g.position.set(x, 0, z);
  scene.add(g);
  floatingLoot.push({ mesh: g, value, phase: Math.random() * Math.PI * 2 });
}

function updateFloatingLoot(dt, t) {
  for (let i = floatingLoot.length - 1; i >= 0; i--) {
    const l = floatingLoot[i];
    l.mesh.position.y = waveHeight(l.mesh.position.x, l.mesh.position.z, t) + 0.35;
    l.mesh.rotation.y += dt * 0.6;
    l.mesh.rotation.z = Math.sin(t * 1.5 + l.phase) * 0.15;
    if (!running) continue;
    const d = Math.hypot(player.pos.x - l.mesh.position.x, player.pos.z - l.mesh.position.z);
    if (d < 8 && player.sinking <= 0) {
      const cap = SHIP_CLASSES[currentClass].cargo;
      if (cargo.length >= cap) {
        if (msgTimer <= 0) showMessage('🎒 船舱已满！回港口出售战利品', 1.5);
        continue;
      }
      cargo.push({ icon: '⚱️', name: '打捞的战利品', value: l.value });
      showMessage(`⚱️ 打捞战利品（价值 ${l.value}）— 船舱 ${cargo.length}/${cap}`);
      scene.remove(l.mesh);
      floatingLoot.splice(i, 1);
    }
  }
}

// ---------- Input ----------
const keys = {};
let cheatBuffer = '';
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'Escape' && shopOpen) closeShop();

  // cheat codes: type the phrase anywhere (ignored while typing in the name input)
  if (document.activeElement !== hud.nameInput && e.key && e.key.length === 1) {
    cheatBuffer = (cheatBuffer + e.key.toLowerCase()).slice(-32);
    if (cheatBuffer.endsWith('show me the money')) {
      cheatBuffer = '';
      gold = 999999;
      showMessage('💰 秘籍生效：SHOW ME THE MONEY — 999999 金币！', 3.5);
    }
  }
});
addEventListener('keyup', e => { keys[e.code] = false; });

// camera orbit
let camYaw = 0, camPitch = 0.32, camDist = 26;
let dragging = false, lastX = 0, lastY = 0;
addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', e => {
  if (!dragging) return;
  camYaw -= (e.clientX - lastX) * 0.005;
  camPitch = THREE.MathUtils.clamp(camPitch + (e.clientY - lastY) * 0.004, 0.05, 1.1);
  lastX = e.clientX; lastY = e.clientY;
});
addEventListener('wheel', e => {
  camDist = THREE.MathUtils.clamp(camDist + e.deltaY * 0.02, 12, 60);
});

// ---------- Charged shots & trajectory preview ----------
const CHARGE_TIME = 1.2;   // seconds to full charge
const TRAJ_POINTS = 64;
let charging = false;
let charge = 0;

const chargeEl = document.getElementById('charge');
const chargeFill = document.getElementById('charge-fill');

// one trajectory line per broadside
const trajLines = [];
for (let i = 0; i < 2; i++) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAJ_POINTS * 3), 3));
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: 0xffd76a, transparent: true, opacity: 0.85,
  }));
  line.visible = false;
  line.frustumCulled = false;
  scene.add(line);
  trajLines.push(line);
}

function chargePower() {
  return 0.6 + 0.9 * charge; // velocity multiplier 0.6x..1.5x (range up to ~2.2x)
}

function updateTrajectory(t) {
  const dirX = Math.cos(player.heading);
  const dirZ = -Math.sin(player.heading);
  const power = chargePower();
  const cxs = player.mesh.userData.cannonXs;
  const cx = cxs[Math.floor(cxs.length / 2)];
  const fireY = player.mesh.userData.fireY || 2.2;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const line = trajLines[s];
    const posAttr = line.geometry.attributes.position;
    let px = player.pos.x + (cx * dirX + side * 1.8 * dirZ) * player.shipScale;
    let py = player.pos.y + fireY;
    let pz = player.pos.z + (-cx * dirZ + side * 1.8 * dirX) * player.shipScale;
    const vel = new THREE.Vector3(side * dirZ, 0.28, -side * dirX).normalize()
      .multiplyScalar(CANNON_SPEED * power);
    vel.x += dirX * player.speed;
    vel.z += dirZ * player.speed;
    const step = 0.09;
    let n = 0;
    for (; n < TRAJ_POINTS; n++) {
      posAttr.setXYZ(n, px, py, pz);
      vel.y -= GRAVITY * step;
      px += vel.x * step; py += vel.y * step; pz += vel.z * step;
      if (py <= waveHeight(px, pz, t)) break;
    }
    line.geometry.setDrawRange(0, n + 1);
    posAttr.needsUpdate = true;
    line.visible = true;
  }
}

function hideTrajectory() {
  for (const l of trajLines) l.visible = false;
}

// ---------- HUD ----------
const hud = {
  gold: document.getElementById('gold'),
  sunk: document.getElementById('sunk'),
  shipName: document.getElementById('ship-name'),
  cargo: document.getElementById('cargo'),
  hullBar: document.querySelector('#hull-bar > div'),
  speed: document.getElementById('speed'),
  sailPips: [...document.querySelectorAll('.sail-pip')],
  message: document.getElementById('message'),
  compassStrip: document.getElementById('compass-strip'),
  overlay: document.getElementById('overlay'),
  overlaySub: document.getElementById('overlay-sub'),
  soloBtn: document.getElementById('solo-btn'),
  mpBtn: document.getElementById('mp-btn'),
  startBtn: document.getElementById('start-btn'),
  nameInput: document.getElementById('name-input'),
  leaderboard: document.getElementById('leaderboard'),
  lbList: document.getElementById('lb-list'),
  lbCount: document.getElementById('lb-count'),
};

// build compass strip (three copies for wraparound)
const COMPASS = ['N', '·', 'NE', '·', 'E', '·', 'SE', '·', 'S', '·', 'SW', '·', 'W', '·', 'NW', '·'];
{
  let html = '';
  for (let rep = 0; rep < 3; rep++) {
    for (const c of COMPASS) {
      html += `<span class="${c.length === 1 && c !== '·' ? 'cardinal' : ''}">${c}</span>`;
    }
  }
  hud.compassStrip.innerHTML = html;
}

let gold = 0, sunkCount = 0;
let cargo = []; // {icon, name, value} — loot in the hold, sold at the port
let msgTimer = 0;
function showMessage(text, dur = 2.5) {
  hud.message.textContent = text;
  hud.message.classList.add('show');
  msgTimer = dur;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- Ship classes & upgrades ----------
const SHIP_CLASSES = [
  { id: 'sloop', name: '单桅快船', en: 'Sloop', cost: 0, hp: 80, cannons: 2, scale: 0.85, speed: 1.15, turn: 1.2, cargo: 4 },
  { id: 'raft', name: '排船', en: 'Raft', cost: 200, hp: 50, cannons: 1, scale: 0.6, speed: 1.3, turn: 1.6, cargo: 2 },
  { id: 'brig', name: '双桅护卫舰', en: 'Brigantine', cost: 400, hp: 130, cannons: 3, scale: 1.0, speed: 1.0, turn: 1.0, cargo: 6 },
  { id: 'galleon', name: '重型盖伦船', en: 'Galleon', cost: 700, hp: 170, cannons: 4, scale: 1.15, speed: 0.92, turn: 0.85, cargo: 8 },
  { id: 'manowar', name: '风帆战列舰', en: "Man o' War", cost: 1200, hp: 220, cannons: 5, scale: 1.3, speed: 0.85, turn: 0.7, cargo: 10 },
];
const UPGRADES = [
  { id: 'hull', name: '船体强化', desc: '每级 +40 最大耐久', costs: [150, 300, 500], level: 0 },
  { id: 'cannons', name: '火炮改良', desc: '每级 +10 炮弹伤害', costs: [150, 300, 500], level: 0 },
  { id: 'sails', name: '船帆加固', desc: '每级 +10% 航速', costs: [150, 300, 500], level: 0 },
];
let currentClass = 0;
let shopOpen = false;

const shopEl = document.getElementById('shop');

function refreshPlayerStats(heal = false) {
  const cls = SHIP_CLASSES[currentClass];
  player.maxHp = cls.hp + UPGRADES[0].level * 40;
  player.cannonDamage = 20 + UPGRADES[1].level * 10;
  player.speedMult = cls.speed * (1 + UPGRADES[2].level * 0.1);
  player.turnMult = cls.turn;
  player.hp = heal ? player.maxHp : Math.min(player.hp, player.maxHp);
  hud.shipName.textContent = cls.en;
}

function openShop() {
  shopOpen = true;
  renderShop();
  shopEl.classList.remove('hidden');
}
function closeShop() {
  shopOpen = false;
  shopEl.classList.add('hidden');
}

function renderShop() {
  document.getElementById('shop-gold').textContent = gold;

  const upEl = document.getElementById('shop-upgrades');
  upEl.innerHTML = '';

  // sell loot row
  {
    const total = cargo.reduce((s, c) => s + c.value, 0);
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML = `
      <div class="shop-info">
        <b>出售战利品</b>
        <small>船舱 ${cargo.length} 件 ${cargo.map(c => c.icon).join(' ') || '（空）'}</small>
      </div>`;
    const btn = document.createElement('button');
    btn.textContent = total <= 0 ? '无战利品' : `出售 💰${total}`;
    btn.disabled = total <= 0;
    btn.addEventListener('click', () => {
      if (total <= 0) return;
      gold += total;
      cargo = [];
      showMessage(`💰 售出战利品，获得 ${total} 金币！`);
      renderShop();
    });
    row.appendChild(btn);
    upEl.appendChild(row);
  }

  // repair row
  {
    const missing = Math.ceil(player.maxHp - player.hp);
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML = `
      <div class="shop-info">
        <b>修理船只</b>
        <small>恢复全部耐久（每点 1 金币）</small>
      </div>`;
    const btn = document.createElement('button');
    btn.textContent = missing <= 0 ? '完好无损' : `修理 💰${missing}`;
    btn.disabled = missing <= 0 || gold < missing;
    btn.addEventListener('click', () => {
      if (gold < missing || missing <= 0) return;
      gold -= missing;
      player.hp = player.maxHp;
      showMessage('⚓ 船体修复完毕！');
      renderShop();
    });
    row.appendChild(btn);
    upEl.appendChild(row);
  }

  // upgrade rows
  for (const up of UPGRADES) {
    const maxed = up.level >= up.costs.length;
    const cost = maxed ? null : up.costs[up.level];
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML = `
      <div class="shop-info">
        <b>${up.name}</b> <span class="lv">${'★'.repeat(up.level)}${'☆'.repeat(up.costs.length - up.level)}</span>
        <small>${up.desc}</small>
      </div>`;
    const btn = document.createElement('button');
    btn.textContent = maxed ? '已满级' : `升级 💰${cost}`;
    btn.disabled = maxed || gold < cost;
    btn.addEventListener('click', () => {
      if (gold < cost) return;
      gold -= cost;
      up.level++;
      refreshPlayerStats(up.id === 'hull');
      showMessage(`⚒️ ${up.name} 升到 ${up.level} 级！`);
      renderShop();
    });
    row.appendChild(btn);
    upEl.appendChild(row);
  }

  // ship rows
  const shEl = document.getElementById('shop-ships');
  shEl.innerHTML = '';
  SHIP_CLASSES.forEach((cls, i) => {
    const owned = i === currentClass;
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML = `
      <div class="shop-info">
        <b>${cls.name}</b> <small>${cls.en}</small>
        <small>耐久 ${cls.hp} · 火炮 ${cls.cannons * 2} 门 · 航速 ×${cls.speed} · 转向 ×${cls.turn} · 船舱 ${cls.cargo}</small>
      </div>`;
    const btn = document.createElement('button');
    btn.textContent = owned ? '当前船只' : `建造 💰${cls.cost}`;
    btn.disabled = owned || gold < cls.cost;
    btn.addEventListener('click', () => {
      if (gold < cls.cost) return;
      gold -= cls.cost;
      currentClass = i;
      player.rebuild({ cannons: cls.cannons, scale: cls.scale, type: cls.id });
      refreshPlayerStats(true);
      showMessage(`🚢 新船下水：${cls.name}！`);
      renderShop();
    });
    row.appendChild(btn);
    shEl.appendChild(row);
  });
}

document.getElementById('shop-close').addEventListener('click', closeShop);

// ---------- Minimap ----------
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');
const MM = 190, MM_C = MM / 2, MM_SCALE = (MM_C - 8) / WORLD_SIZE;

function drawMinimap(t) {
  mmCtx.clearRect(0, 0, MM, MM);

  // sea disc
  mmCtx.fillStyle = 'rgba(8, 25, 45, 0.85)';
  mmCtx.beginPath();
  mmCtx.arc(MM_C, MM_C, MM_C - 2, 0, Math.PI * 2);
  mmCtx.fill();
  mmCtx.strokeStyle = 'rgba(243,233,200,.4)';
  mmCtx.lineWidth = 1;
  mmCtx.stroke();

  const toMap = (x, z) => [MM_C + x * MM_SCALE, MM_C + z * MM_SCALE];

  // islands
  for (const isl of islands) {
    const [x, y] = toMap(isl.x, isl.z);
    mmCtx.fillStyle = isl.isPort ? '#c98f3d' : '#3f7a3a';
    mmCtx.beginPath();
    mmCtx.arc(x, y, Math.max(2.5, isl.r * MM_SCALE), 0, Math.PI * 2);
    mmCtx.fill();
    if (isl.isPort) {
      mmCtx.fillStyle = '#ffe9a8';
      mmCtx.font = 'bold 8px sans-serif';
      mmCtx.textAlign = 'center';
      mmCtx.fillText('港', x, y - 5);
    }
  }

  // treasures
  mmCtx.strokeStyle = '#ff5a4e';
  mmCtx.lineWidth = 1.4;
  for (const isl of islands) {
    const tr = isl.treasure;
    if (!tr || !tr.active || tr.dug) continue;
    const [x, y] = toMap(tr.x, tr.z);
    mmCtx.beginPath();
    mmCtx.moveTo(x - 2.5, y - 2.5); mmCtx.lineTo(x + 2.5, y + 2.5);
    mmCtx.moveTo(x + 2.5, y - 2.5); mmCtx.lineTo(x - 2.5, y + 2.5);
    mmCtx.stroke();
  }

  // extraction point (pulsing diamond)
  {
    const [x, y] = toMap(extraction.x, extraction.z);
    const p = 4 + Math.sin(t * 3) * 1.5;
    mmCtx.fillStyle = '#7fe7ff';
    mmCtx.beginPath();
    mmCtx.moveTo(x, y - p); mmCtx.lineTo(x + p, y);
    mmCtx.lineTo(x, y + p); mmCtx.lineTo(x - p, y);
    mmCtx.closePath();
    mmCtx.fill();
  }

  // floating loot
  mmCtx.fillStyle = '#ffc93c';
  for (const l of floatingLoot) {
    const [x, y] = toMap(l.mesh.position.x, l.mesh.position.z);
    mmCtx.fillRect(x - 1.5, y - 1.5, 3, 3);
  }

  // AI enemies (solo)
  mmCtx.fillStyle = '#ff3b30';
  for (const e of enemies) {
    if (e.dead || e.sinking > 0) continue;
    const [x, y] = toMap(e.pos.x, e.pos.z);
    mmCtx.beginPath();
    mmCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    mmCtx.fill();
  }

  // other players (multiplayer)
  if (mode === 'mp') {
    mmCtx.fillStyle = '#9fd7ff';
    for (const r of net.remotes.values()) {
      if (r.ship.dead || r.ship.sinking > 0) continue;
      const [x, y] = toMap(r.ship.pos.x, r.ship.pos.z);
      mmCtx.beginPath();
      mmCtx.arc(x, y, 2.5, 0, Math.PI * 2);
      mmCtx.fill();
    }
  }

  // player arrow
  {
    const [x, y] = toMap(player.pos.x, player.pos.z);
    mmCtx.save();
    mmCtx.translate(x, y);
    mmCtx.rotate(-player.heading);
    mmCtx.fillStyle = '#ffffff';
    mmCtx.beginPath();
    mmCtx.moveTo(5.5, 0); mmCtx.lineTo(-3.5, 3.2); mmCtx.lineTo(-3.5, -3.2);
    mmCtx.closePath();
    mmCtx.fill();
    mmCtx.restore();
  }
}

// ---------- Network (multiplayer) ----------
const net = {
  ws: null, id: null, connected: false,
  remotes: new Map(), // id -> remote player record
  sendTimer: 0,
};
let mode = 'solo';

const PIRATE_NAMES = ['黑胡子', '红胡子', '独眼龙', '老船长', '海狼', '风暴之子', '金牙', '夜行者'];
function randomName() {
  return PIRATE_NAMES[Math.floor(Math.random() * PIRATE_NAMES.length)] + Math.floor(Math.random() * 100);
}

function netSend(obj) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
}

function connectMP(name) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  net.ws = ws;
  hud.overlaySub.textContent = '连接服务器中…';
  ws.onopen = () => netSend({ t: 'join', name });
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleNet(msg);
  };
  ws.onclose = () => {
    net.connected = false;
    if (mode === 'mp' && running) showMessage('与服务器断开连接…', 5);
  };
  ws.onerror = () => {
    hud.overlaySub.textContent = '无法连接到服务器——请用 node server.js 启动';
  };
}

function makeNameTag(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = 'bold 34px "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.lineWidth = 6;
  ctx.strokeText(text, 128, 44);
  ctx.fillStyle = '#ffe9a8';
  ctx.fillText(text, 128, 44);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(10, 2.5, 1);
  return sp;
}

function createRemote(p) {
  const cls = SHIP_CLASSES[p.cls] || SHIP_CLASSES[0];
  const ship = new Ship({
    remote: true, type: cls.id, x: p.x, z: p.z, heading: p.heading,
    cannons: p.cannons, scale: p.scale, maxHp: p.maxHp,
  });
  ship.sailLevel = p.sailLevel;
  const tag = makeNameTag(p.name || 'Pirate');
  tag.position.set(0, 12 / p.scale, 0);
  ship.mesh.add(tag);
  return {
    id: p.id, name: p.name, ship, tag,
    tx: p.x, tz: p.z, th: p.heading, tsail: p.sailLevel,
    cls: p.cls, cannons: p.cannons, scale: p.scale,
    gold: 0, sunk: 0, seen: true,
  };
}

function updateRemotes(dt, t) {
  for (const r of net.remotes.values()) {
    const ship = r.ship;
    if (ship.dead) continue;
    if (ship.sinking > 0) { ship.update(dt, t); continue; }
    const k = Math.min(1, dt * 8);
    ship.pos.x += (r.tx - ship.pos.x) * k;
    ship.pos.z += (r.tz - ship.pos.z) * k;
    let dh = ((r.th - ship.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    ship.heading += dh * k;
    ship.sailLevel = r.tsail;
    ship.applyWaveRide(t);
    ship.updateSailVisual(dt);
  }
}

function handleNet(msg) {
  switch (msg.t) {
    case 'welcome':
      net.id = msg.id;
      net.connected = true;
      player.pos.set(msg.x, 0, msg.z);
      hud.overlay.classList.add('hidden');
      hud.leaderboard.classList.remove('hidden');
      running = true;
      showMessage('欢迎来到 Sea of Rouge！', 3);
      break;

    case 'snap': {
      for (const p of msg.players) {
        if (p.id === net.id) {
          // server-authoritative hp (but don't override while we're sinking)
          if (player.sinking <= 0) player.hp = p.hp;
          continue;
        }
        let r = net.remotes.get(p.id);
        if (!r) {
          r = createRemote(p);
          net.remotes.set(p.id, r);
        }
        r.tx = p.x; r.tz = p.z; r.th = p.heading; r.tsail = p.sailLevel;
        r.gold = p.gold; r.sunk = p.sunk; r.name = p.name;
        if (r.cls !== p.cls) {
          r.cls = p.cls; r.cannons = p.cannons; r.scale = p.scale;
          const cls = SHIP_CLASSES[p.cls] || SHIP_CLASSES[0];
          r.ship.rebuild({ cannons: p.cannons, scale: p.scale, type: cls.id });
          r.tag.position.set(0, 12 / p.scale, 0);
          r.ship.mesh.add(r.tag);
        }
        r.seen = true;
      }
      // remove stale remotes
      for (const [id, r] of net.remotes) {
        if (!r.seen) {
          scene.remove(r.ship.mesh);
          net.remotes.delete(id);
        } else {
          r.seen = false;
        }
      }
      // leaderboard
      const rows = msg.players.slice().sort((a, b) => b.gold - a.gold).slice(0, 5);
      hud.lbList.innerHTML = rows.map(p =>
        `<li class="${p.id === net.id ? 'me' : ''}">${escapeHtml(p.name)} — 💰${p.gold}</li>`
      ).join('');
      hud.lbCount.textContent = `在线 ${msg.players.length} 名海盗`;
      break;
    }

    case 'fire': {
      // another player fired: render the volley locally (server does hit detection)
      const r = net.remotes.get(msg.owner);
      const ownerShip = r ? r.ship : null;
      for (const b of msg.balls) {
        cannonballs.push(new Cannonball(
          b.x, b.y, b.z, new THREE.Vector3(b.vx, b.vy, b.vz), ownerShip || player
        ));
      }
      if (r) spawnMuzzleFlash(r.ship);
      break;
    }

    case 'hit': {
      spawnHitEffect(msg.x, msg.y, msg.z);
      if (msg.target === net.id) {
        player.hp = msg.hp;
        showMessage('船体被击中！我们正在进水！');
      } else if (msg.by === net.id) {
        showMessage('🎯 命中敌船！', 1.2);
      }
      break;
    }

    case 'sink': {
      // the victim drops a loot chest anyone can salvage
      if (typeof msg.x === 'number') spawnFloatingLoot(msg.x, msg.z, 100);
      if (msg.id === net.id) {
        player.sinking = 0.001;
        hideTrajectory();
        charging = false;
        chargeEl.classList.remove('show');
        showMessage('💀 你的船被击沉了！即将重生…', 3);
      } else {
        const r = net.remotes.get(msg.id);
        if (r) r.ship.sinking = 0.001;
        if (msg.by === net.id) {
          sunkCount++;
          showMessage(`💀 击沉 ${r ? r.name : '敌船'}！战利品落水，驶过去打捞`);
        } else if (r) {
          showMessage(`💀 ${r.name} 的船沉没了`, 2);
        }
      }
      break;
    }

    case 'respawn': {
      if (msg.id === net.id) {
        player.sinking = 0;
        player.dead = false;
        player.hp = msg.hp;
        player.pos.set(msg.x, 0, msg.z);
        player.mesh.rotation.set(0, player.heading, 0);
        player.speed = 0;
        player.sailLevel = 0;
        if (!player.mesh.parent) scene.add(player.mesh);
        showMessage('⚓ 新船下水，重新出发！');
      } else {
        const r = net.remotes.get(msg.id);
        if (r) {
          if (r.ship.dead) {
            scene.remove(r.ship.mesh);
            const cls = SHIP_CLASSES[r.cls] || SHIP_CLASSES[0];
            r.ship = new Ship({
              remote: true, type: cls.id, x: msg.x, z: msg.z,
              cannons: r.cannons, scale: r.scale, maxHp: msg.hp,
            });
            r.ship.mesh.add(r.tag);
          } else {
            r.ship.sinking = 0;
            r.ship.pos.set(msg.x, 0, msg.z);
            r.ship.mesh.rotation.set(0, r.ship.heading, 0);
          }
          r.tx = msg.x; r.tz = msg.z;
        }
      }
      break;
    }
  }
}

// ---------- Game state ----------
let running = false;

function startGame(selected) {
  mode = selected;
  if (mode === 'mp') {
    const name = (hud.nameInput.value || '').trim() || randomName();
    connectMP(name);
  } else {
    hud.overlay.classList.add('hidden');
    running = true;
    for (let i = 0; i < ENEMY_COUNT; i++) spawnEnemy();
  }
}

hud.soloBtn.addEventListener('click', () => startGame('solo'));
hud.mpBtn.addEventListener('click', () => startGame('mp'));

function endGame(win) {
  running = false;
  hud.overlay.querySelector('h1').textContent = win ? '安全撤离！' : 'Ye Be Sunk!';
  hud.overlay.querySelector('h2').textContent = win
    ? `成功撤离！带走 ${gold} 金币，击沉 ${sunkCount} 艘敌船。传奇海盗就是你！`
    : `Yer ship rests with Davy Jones. 最终收获：${gold} 金币。`;
  hud.soloBtn.style.display = 'none';
  hud.mpBtn.style.display = 'none';
  hud.nameInput.style.display = 'none';
  hud.startBtn.style.display = 'inline-block';
  hud.overlaySub.textContent = '点击按钮开始新的航程';
  hud.overlay.classList.remove('hidden');
  hud.startBtn.onclick = () => location.reload();
}

// ---------- Proximity checks ----------
function nearPort() {
  return Math.hypot(player.pos.x - port.x, player.pos.z - port.z) < port.r + 24;
}
function nearExtraction() {
  return Math.hypot(player.pos.x - extraction.x, player.pos.z - extraction.z) < 26;
}

// ---------- Enemy AI (solo mode) ----------
function updateEnemy(e, dt) {
  if (e.dead || e.sinking > 0) return;
  const dx = player.pos.x - e.pos.x;
  const dz = player.pos.z - e.pos.z;
  const dist = Math.hypot(dx, dz);
  const angleTo = Math.atan2(-dz, dx); // matches heading convention

  e.aiTimer -= dt;
  if (e.aiTimer <= 0) {
    e.aiTimer = 1.5 + Math.random() * 2;
    if (dist < 160) {
      // circle the player: aim perpendicular-ish
      const desired = angleTo + (Math.random() > 0.5 ? 0.9 : -0.9);
      e.aiTurn = Math.sign(Math.sin(desired - e.heading)) * 1;
      e.sailLevel = dist < 60 ? 1 : 2;
    } else {
      const desired = angleTo + (Math.random() - 0.5) * 0.8;
      e.aiTurn = Math.sign(Math.sin(desired - e.heading)) * 1;
      e.sailLevel = 3;
    }
  }
  e.turnInput = e.aiTurn;

  // avoid islands crudely
  for (const isl of islands) {
    const d = Math.hypot(e.pos.x - isl.x, e.pos.z - isl.z);
    if (d < isl.r + 30) {
      e.turnInput = Math.sign(Math.sin(Math.atan2(-(e.pos.z - isl.z), e.pos.x - isl.x) - e.heading)) || 1;
      break;
    }
  }

  // fire when broadside roughly faces player
  if (dist < 90 && e.cooldown <= 0) {
    const rel = Math.abs(Math.sin(angleTo - e.heading));
    if (rel > 0.8) e.fireBroadside(cannonballs);
  }
}

// ---------- Island collision ----------
function collideIslands(ship) {
  for (const isl of islands) {
    const dx = ship.pos.x - isl.x;
    const dz = ship.pos.z - isl.z;
    const d = Math.hypot(dx, dz);
    const minD = isl.r * 0.95 + 3;
    if (d < minD && d > 0.01) {
      const push = (minD - d) / d;
      ship.pos.x += dx * push;
      ship.pos.z += dz * push;
      if (ship.speed > 4 && !ship.enemy && mode === 'solo') {
        ship.damage(5);
        showMessage('Ye ran aground! Hull damaged! 搁浅了，船体受损！');
      }
      ship.speed *= 0.4;
    }
  }
}

// ---------- Treasure digging ----------
function nearestTreasure() {
  let best = null, bestD = 26;
  for (const isl of islands) {
    const tr = isl.treasure;
    if (!tr || !tr.active || tr.dug) continue;
    const d = Math.hypot(player.pos.x - tr.x, player.pos.z - tr.z);
    if (d < bestD) { bestD = d; best = { isl, tr }; }
  }
  return best;
}

function tryDig() {
  const found = nearestTreasure();
  if (!found) return;
  const cap = SHIP_CLASSES[currentClass].cargo;
  if (cargo.length >= cap) {
    showMessage('🎒 船舱已满！回港口出售战利品', 2.5);
    return;
  }
  found.tr.dug = true;
  found.tr.chest.visible = true;
  const haul = 80 + Math.floor(Math.random() * 120);
  cargo.push({ icon: '💰', name: '宝藏箱', value: haul });
  showMessage(`💰 宝藏装入船舱（${cargo.length}/${cap}）— 回港出售换取金币`);
  setTimeout(() => {
    scene.remove(found.tr.group);
    spawnTreasure(found.isl);
  }, 4000);
}

// ---------- Solo-mode cannonball damage ----------
function damageShipSolo(tgt, dmg, byPlayer, silent = false) {
  const wasAlive = tgt.hp > 0;
  tgt.damage(dmg);
  if (tgt === player) {
    if (!silent) showMessage('船体被击中！我们正在进水！');
    if (wasAlive && player.hp <= 0) setTimeout(() => endGame(false), 2500);
  } else if (wasAlive && tgt.hp <= 0 && byPlayer) {
    sunkCount++;
    spawnFloatingLoot(tgt.pos.x, tgt.pos.z, 50);
    showMessage('💀 击沉敌船！战利品落水，驶过去打捞');
  }
}

// ---------- Main loop ----------
const clock = new THREE.Clock();
let sailKeyRepeat = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  oceanUniforms.uTime.value = t;

  // extraction beacon pulse (always visible)
  extraction.ring.scale.setScalar(1 + Math.sin(t * 2) * 0.08);
  extraction.beam.material.opacity = 0.16 + 0.08 * Math.sin(t * 3);

  if (running && !shopOpen) {
    // --- player input ---
    sailKeyRepeat -= dt;
    if (sailKeyRepeat <= 0) {
      if (keys['KeyW'] && player.sailLevel < 3) { player.sailLevel++; sailKeyRepeat = 0.25; }
      if (keys['KeyS'] && player.sailLevel > 0) { player.sailLevel--; sailKeyRepeat = 0.25; }
    }
    player.turnInput = (keys['KeyA'] ? 1 : 0) - (keys['KeyD'] ? 1 : 0);

    // charged broadside: hold Space to charge (shows trajectory), release to fire
    if (keys['Space'] && !charging && player.cooldown <= 0 && player.sinking <= 0) {
      charging = true;
      charge = 0;
    }
    if (charging) {
      charge = Math.min(1, charge + dt / CHARGE_TIME);
      updateTrajectory(t);
      chargeEl.classList.add('show');
      chargeFill.style.width = `${charge * 100}%`;
      if (!keys['Space']) {
        charging = false;
        hideTrajectory();
        chargeEl.classList.remove('show');
        if (player.fireBroadside(cannonballs, chargePower()) && mode === 'mp') {
          netSend({
            t: 'fire',
            damage: player.cannonDamage,
            balls: player.lastFired.map(b => ({
              x: b.mesh.position.x, y: b.mesh.position.y, z: b.mesh.position.z,
              vx: b.vel.x, vy: b.vel.y, vz: b.vel.z,
            })),
          });
        }
      }
    }

    if (keys['KeyF']) {
      keys['KeyF'] = false;
      if (nearPort()) openShop();
      else if (nearExtraction()) endGame(true);
      else tryDig();
    }

    // --- update ships ---
    player.update(dt, t);
    collideIslands(player);
    if (mode === 'solo') {
      for (const e of enemies) {
        updateEnemy(e, dt);
        e.update(dt, t);
        collideIslands(e);
      }
      // respawn dead enemies
      for (let i = enemies.length - 1; i >= 0; i--) {
        if (enemies[i].dead) { enemies.splice(i, 1); spawnEnemy(); }
      }
    } else {
      updateRemotes(dt, t);
      // report state at 10 Hz
      net.sendTimer -= dt;
      if (net.sendTimer <= 0 && net.connected) {
        net.sendTimer = 0.1;
        netSend({
          t: 'state',
          x: player.pos.x, y: player.pos.y, z: player.pos.z,
          heading: player.heading, speed: player.speed, sailLevel: player.sailLevel,
          gold, sunk: sunkCount,
          cls: currentClass,
          scale: SHIP_CLASSES[currentClass].scale,
          cannons: SHIP_CLASSES[currentClass].cannons,
          maxHp: player.maxHp,
        });
      }
    }

    // --- cannonballs ---
    for (let i = cannonballs.length - 1; i >= 0; i--) {
      const cb = cannonballs[i];
      const res = cb.update(dt, t);
      if (res !== true) {
        // near-miss splash damage (solo only; server handles it in MP)
        if (res === 'water' && mode === 'solo') {
          const p = cb.mesh.position;
          const targets = cb.owner === player ? enemies : [player];
          for (const tgt of targets) {
            if (tgt.dead || tgt.sinking > 0) continue;
            if (Math.hypot(tgt.pos.x - p.x, tgt.pos.z - p.z) < NEAR_MISS_RADIUS * tgt.shipScale) {
              damageShipSolo(tgt, NEAR_MISS_DAMAGE, cb.owner === player, true);
            }
          }
        }
        scene.remove(cb.mesh);
        cannonballs.splice(i, 1);
        continue;
      }
      // direct OBB hit (solo only; server is authoritative in MP)
      if (mode === 'solo') {
        const targets = cb.owner === player ? enemies : [player];
        for (const tgt of targets) {
          if (tgt.dead || tgt.sinking > 0) continue;
          if (cannonballHitsShip(cb.mesh.position, tgt)) {
            spawnHitEffect(cb.mesh.position.x, cb.mesh.position.y, cb.mesh.position.z);
            damageShipSolo(tgt, cb.owner.cannonDamage || 20, cb.owner === player);
            scene.remove(cb.mesh);
            cannonballs.splice(i, 1);
            break;
          }
        }
      }
    }

    // --- context prompts ---
    if (msgTimer <= 0) {
      if (nearPort()) showMessage('🏘️ 港口 — 按 F 靠港交易（出售 / 修理 / 升级 / 造新船）', 0.5);
      else if (nearExtraction()) showMessage('🛶 撤离点 — 按 F 带着战利品撤离！', 0.5);
      else if (nearestTreasure()) showMessage('X marks the spot — 按 F 挖掘宝藏！', 0.5);
    }

    // --- HUD ---
    hud.gold.textContent = gold;
    hud.sunk.textContent = sunkCount;
    hud.cargo.textContent = `${cargo.length}/${SHIP_CLASSES[currentClass].cargo}`;
    hud.hullBar.style.width = `${(player.hp / player.maxHp) * 100}%`;
    hud.speed.textContent = `${(player.speed * 1.8).toFixed(0)} kn`;
    hud.sailPips.forEach((p, i) => p.classList.toggle('on', i < player.sailLevel));

    // compass: heading 0 = +X = East in our convention
    let deg = 90 - THREE.MathUtils.radToDeg(player.heading);
    deg = ((deg % 360) + 360) % 360;
    const pxPerDeg = 60 / 22.5; // each span = 22.5 degrees, 60px wide
    hud.compassStrip.style.left = `${210 - (deg + 360) * pxPerDeg - 30}px`;

    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) hud.message.classList.remove('show');
    }
  }

  updateParticles(dt);
  updateFloatingLoot(dt, t);
  drawMinimap(t);

  // --- camera follows player ---
  const camAngle = player.heading + Math.PI + camYaw;
  const cx = player.pos.x + Math.cos(camAngle) * camDist * Math.cos(camPitch);
  const cz = player.pos.z - Math.sin(camAngle) * camDist * Math.cos(camPitch);
  const cy = player.pos.y + 4 + Math.sin(camPitch) * camDist;
  camera.position.lerp(new THREE.Vector3(cx, cy, cz), Math.min(1, dt * 5));
  camera.lookAt(player.pos.x, player.pos.y + 5, player.pos.z);

  // sun shadow follows player
  sun.position.copy(player.pos).addScaledVector(sunDir, 300);
  sun.target.position.copy(player.pos);

  renderer.render(scene, camera);
}

refreshPlayerStats(false);
tick();
