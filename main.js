import * as THREE from 'three';

// ============================================================
// Sea of Rouge — a Sea of Thieves-inspired three.js toy game
// ============================================================

// ---------- Config ----------
const WORLD_SIZE = 1600;          // playable radius
const ISLAND_COUNT = 7;
const ENEMY_COUNT = 3;
const GRAVITY = 22;
const CANNON_SPEED = 55;
const CANNON_COOLDOWN = 1.4;
const ENEMY_MAX_HP = 60;
const ENEMY_CANNON_DAMAGE = 20;

// ---------- Waves (shared between GLSL and JS) ----------
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
  hull: new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.85 }),
  hullDark: new THREE.MeshStandardMaterial({ color: 0x3c2716, roughness: 0.9 }),
  deck: new THREE.MeshStandardMaterial({ color: 0x8a6a42, roughness: 0.9 }),
  mast: new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 0.85 }),
  sail: new THREE.MeshStandardMaterial({ color: 0xe8ddc0, roughness: 0.95, side: THREE.DoubleSide }),
  sailEnemy: new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.95, side: THREE.DoubleSide }),
  cannon: new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.5, metalness: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.3, metalness: 0.8, emissive: 0x664400 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xd9c08a, roughness: 1 }),
  grass: new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 1 }),
  rock: new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 1 }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 1, side: THREE.DoubleSide }),
  flag: new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 1, side: THREE.DoubleSide }),
};

// ---------- Ship builder ----------
function buildShip({ enemy = false, cannons = 3, scale = 1 } = {}) {
  const ship = new THREE.Group();

  // Hull: tapered box via extruded shape
  const hullShape = new THREE.Shape();
  hullShape.moveTo(-4.5, 0);
  hullShape.lineTo(-3.4, 1.6);
  hullShape.lineTo(3.2, 1.6);
  hullShape.quadraticCurveTo(5.2, 0.9, 5.6, 0);
  hullShape.quadraticCurveTo(5.2, -0.9, 3.2, -1.6);
  hullShape.lineTo(-3.4, -1.6);
  hullShape.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(hullShape, { depth: 2.2, bevelEnabled: false });
  hullGeo.rotateX(Math.PI / 2); // shape XY -> XZ, extrude becomes height
  hullGeo.translate(0, 2.2, 0);
  const hull = new THREE.Mesh(hullGeo, MAT.hull);
  hull.castShadow = true;
  ship.add(hull);

  // Deck
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.15, 2.9), MAT.deck);
  deck.position.set(-0.2, 2.25, 0);
  ship.add(deck);

  // Stern castle
  const stern = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 2.8), MAT.hullDark);
  stern.position.set(-3.4, 3.0, 0);
  stern.castShadow = true;
  ship.add(stern);

  // Bowsprit
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 3.2), MAT.mast);
  bowsprit.rotation.z = -Math.PI / 2 + 0.35;
  bowsprit.position.set(6.0, 2.9, 0);
  ship.add(bowsprit);

  // Masts + sails
  const sailMat = enemy ? MAT.sailEnemy : MAT.sail;
  const sails = [];
  const mastDefs = [
    { x: 1.6, h: 8.5, sailW: 4.6, sailH: 4.2 },
    { x: -2.2, h: 7.0, sailW: 3.8, sailH: 3.4 },
  ];
  for (const md of mastDefs) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, md.h), MAT.mast);
    mast.position.set(md.x, 2.2 + md.h / 2, 0);
    mast.castShadow = true;
    ship.add(mast);

    // curved sail
    const sailGeo = new THREE.PlaneGeometry(md.sailW, md.sailH, 8, 4);
    const pos = sailGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const bulge = Math.cos((y / md.sailH) * Math.PI * 0.5) * 0.9;
      pos.setZ(i, bulge);
    }
    sailGeo.computeVertexNormals();
    const sail = new THREE.Mesh(sailGeo, sailMat);
    sail.rotation.y = Math.PI / 2;
    sail.position.set(md.x - 0.15, 2.2 + md.h * 0.55, 0);
    sail.castShadow = true;
    ship.add(sail);
    sails.push(sail);

    // yard
    const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, md.sailW + 0.6), MAT.mast);
    yard.rotation.x = Math.PI / 2;
    yard.position.set(md.x - 0.15, 2.2 + md.h * 0.55 + md.sailH / 2, 0);
    ship.add(yard);
  }

  // Flag
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.8), MAT.flag);
  flag.position.set(1.6, 2.2 + 8.5 + 0.4, 0.7);
  ship.add(flag);

  // Cannons on both broadsides
  const cannonGeo = new THREE.CylinderGeometry(0.16, 0.2, 1.4);
  cannonGeo.rotateX(Math.PI / 2);
  const cannonXs = cannons === 1 ? [-0.4]
    : Array.from({ length: cannons }, (_, i) => -2.4 + (i * 4.0) / (cannons - 1));
  for (const side of [-1, 1]) {
    for (const cx of cannonXs) {
      const c = new THREE.Mesh(cannonGeo, MAT.cannon);
      c.position.set(cx, 2.1, side * 1.55);
      ship.add(c);
    }
  }

  ship.scale.setScalar(scale);
  ship.userData.sails = sails;
  ship.userData.cannonXs = cannonXs;
  return ship;
}

// ---------- Ship entity ----------
class Ship {
  constructor({ enemy = false, x = 0, z = 0, heading = 0, cannons = 3, scale = 1,
                speedMult = 1, cannonDamage = 20, maxHp = 100 } = {}) {
    this.enemy = enemy;
    this.shipScale = scale;
    this.speedMult = speedMult;
    this.cannonDamage = cannonDamage;
    this.mesh = buildShip({ enemy, cannons, scale });
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
    // enemy AI
    this.aiTimer = 0;
    this.aiTurn = 0;
    scene.add(this.mesh);
  }

  get pos() { return this.mesh.position; }

  rebuild({ cannons, scale }) {
    const pos = this.pos.clone();
    scene.remove(this.mesh);
    this.mesh = buildShip({ enemy: this.enemy, cannons, scale });
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
    const turnRate = 0.45 * Math.min(1, this.speed / 4 + 0.25);
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

    // wave riding: sample height at bow/stern/port/starboard
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

    // sail visual follows sail level
    const sailScale = 0.25 + (this.sailLevel / 3) * 0.75;
    for (const s of this.mesh.userData.sails) {
      s.scale.y += (sailScale - s.scale.y) * Math.min(1, dt * 3);
    }

    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  fireBroadside(cannonballs) {
    if (this.cooldown > 0 || this.sinking > 0 || this.dead) return false;
    this.cooldown = CANNON_COOLDOWN;
    const dirX = Math.cos(this.heading);
    const dirZ = -Math.sin(this.heading);
    // fire from both sides
    for (const side of [-1, 1]) {
      for (const cx of this.mesh.userData.cannonXs) {
        const ox = (cx * dirX + side * 1.8 * dirZ) * this.shipScale;
        const oz = (-cx * dirZ + side * 1.8 * dirX) * this.shipScale;
        const vel = new THREE.Vector3(side * dirZ, 0.28, -side * dirX).normalize()
          .multiplyScalar(CANNON_SPEED * (0.92 + Math.random() * 0.16));
        vel.x += dirX * this.speed;
        vel.z += dirZ * this.speed;
        cannonballs.push(new Cannonball(
          this.pos.x + ox, this.pos.y + 2.2, this.pos.z + oz, vel, this
        ));
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
  update(dt, t) {
    this.life -= dt;
    this.vel.y -= GRAVITY * dt;
    this.mesh.position.addScaledVector(this.vel, dt);
    const p = this.mesh.position;
    if (p.y <= waveHeight(p.x, p.z, t)) {
      spawnSplash(p.x, p.z, t);
      return false;
    }
    return this.life > 0;
  }
}

// ---------- Particles (splashes & flashes) ----------
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

function spawnMuzzleFlash(ship) {
  const dirX = Math.cos(ship.heading), dirZ = -Math.sin(ship.heading);
  for (const side of [-1, 1]) {
    for (const cx of ship.mesh.userData.cannonXs) {
      const m = new THREE.Mesh(splashGeo, new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true }));
      m.position.set(
        ship.pos.x + (cx * dirX + side * 2.4 * dirZ) * ship.shipScale,
        ship.pos.y + 2.2,
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
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(r * 0.1 + Math.random() * r * 0.06), MAT.rock);
    const a = Math.random() * Math.PI * 2;
    rock.position.set(Math.cos(a) * r * 0.5, 1.2, Math.sin(a) * r * 0.5);
    rock.castShadow = true;
    g.add(rock);
  }

  // palm trees
  const palms = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < palms; i++) {
    const palm = new THREE.Group();
    const a = Math.random() * Math.PI * 2;
    const pr = r * (0.25 + Math.random() * 0.3);
    palm.position.set(Math.cos(a) * pr, 1.5, Math.sin(a) * pr);
    const lean = (Math.random() - 0.5) * 0.5;
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
    const a = Math.random() * Math.PI * 2;
    const d = 220 + Math.random() * (WORLD_SIZE - 350);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const r = 26 + Math.random() * 22;
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
  const a = Math.random() * Math.PI * 2;
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
  const a = Math.random() * Math.PI * 2;
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
  x: 0, z: 0, heading: Math.PI / 2,
  cannons: 2, scale: 0.85, speedMult: 1.15, cannonDamage: 20, maxHp: 80,
});
const enemies = [];
const cannonballs = [];

function spawnEnemy() {
  const a = Math.random() * Math.PI * 2;
  const d = 300 + Math.random() * 500;
  const e = new Ship({
    enemy: true,
    x: player.pos.x + Math.cos(a) * d,
    z: player.pos.z + Math.sin(a) * d,
    heading: Math.random() * Math.PI * 2,
    cannons: 3, scale: 1, speedMult: 1, cannonDamage: ENEMY_CANNON_DAMAGE, maxHp: ENEMY_MAX_HP,
  });
  e.sailLevel = 2;
  enemies.push(e);
}
for (let i = 0; i < ENEMY_COUNT; i++) spawnEnemy();

// ---------- Input ----------
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'Escape' && shopOpen) closeShop();
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

// ---------- HUD ----------
const hud = {
  gold: document.getElementById('gold'),
  sunk: document.getElementById('sunk'),
  shipName: document.getElementById('ship-name'),
  hullBar: document.querySelector('#hull-bar > div'),
  speed: document.getElementById('speed'),
  sailPips: [...document.querySelectorAll('.sail-pip')],
  message: document.getElementById('message'),
  compassStrip: document.getElementById('compass-strip'),
  overlay: document.getElementById('overlay'),
  overlaySub: document.getElementById('overlay-sub'),
  startBtn: document.getElementById('start-btn'),
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
let msgTimer = 0;
function showMessage(text, dur = 2.5) {
  hud.message.textContent = text;
  hud.message.classList.add('show');
  msgTimer = dur;
}

// ---------- Shop / upgrades ----------
const SHIP_CLASSES = [
  { name: '单桅快船', en: 'Sloop', cost: 0, hp: 80, cannons: 2, scale: 0.85, speed: 1.15 },
  { name: '双桅护卫舰', en: 'Brigantine', cost: 400, hp: 130, cannons: 3, scale: 1.0, speed: 1.0 },
  { name: '风帆战列舰', en: "Man o' War", cost: 900, hp: 200, cannons: 4, scale: 1.2, speed: 0.88 },
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
        <small>耐久 ${cls.hp} · 火炮 ${cls.cannons * 2} 门 · 航速 ×${cls.speed}</small>
      </div>`;
    const btn = document.createElement('button');
    btn.textContent = owned ? '当前船只' : `建造 💰${cls.cost}`;
    btn.disabled = owned || gold < cls.cost;
    btn.addEventListener('click', () => {
      if (gold < cls.cost) return;
      gold -= cls.cost;
      currentClass = i;
      player.rebuild({ cannons: cls.cannons, scale: cls.scale });
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

  // enemies
  mmCtx.fillStyle = '#ff3b30';
  for (const e of enemies) {
    if (e.dead || e.sinking > 0) continue;
    const [x, y] = toMap(e.pos.x, e.pos.z);
    mmCtx.beginPath();
    mmCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    mmCtx.fill();
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

// ---------- Game state ----------
let running = false;

hud.startBtn.addEventListener('click', () => {
  hud.overlay.classList.add('hidden');
  running = true;
});

function endGame(win) {
  running = false;
  hud.overlay.querySelector('h1').textContent = win ? '安全撤离！' : 'Ye Be Sunk!';
  hud.overlay.querySelector('h2').textContent = win
    ? `成功撤离！带走 ${gold} 金币，击沉 ${sunkCount} 艘敌船。传奇海盗就是你！`
    : `Yer ship rests with Davy Jones. 最终收获：${gold} 金币。`;
  hud.startBtn.textContent = '再次启航 Sail Again';
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

// ---------- Enemy AI ----------
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
      if (ship.speed > 4 && !ship.enemy) {
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
  found.tr.dug = true;
  found.tr.chest.visible = true;
  const haul = 80 + Math.floor(Math.random() * 120);
  gold += haul;
  showMessage(`💰 挖出 ${haul} 金币！`);
  setTimeout(() => {
    scene.remove(found.tr.group);
    spawnTreasure(found.isl);
  }, 4000);
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
    if (keys['Space']) { player.fireBroadside(cannonballs); }
    if (keys['KeyF']) {
      keys['KeyF'] = false;
      if (nearPort()) openShop();
      else if (nearExtraction()) endGame(true);
      else tryDig();
    }

    // --- update ships ---
    player.update(dt, t);
    collideIslands(player);
    for (const e of enemies) {
      updateEnemy(e, dt);
      e.update(dt, t);
      collideIslands(e);
    }

    // respawn dead enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i].dead) { enemies.splice(i, 1); spawnEnemy(); }
    }

    // --- cannonballs ---
    for (let i = cannonballs.length - 1; i >= 0; i--) {
      const cb = cannonballs[i];
      if (!cb.update(dt, t)) {
        scene.remove(cb.mesh);
        cannonballs.splice(i, 1);
        continue;
      }
      // hit ships
      const targets = cb.owner === player ? enemies : [player];
      for (const tgt of targets) {
        if (tgt.dead || tgt.sinking > 0) continue;
        const d = cb.mesh.position.distanceTo(tgt.pos);
        if (d < 4.5 * tgt.shipScale) {
          tgt.damage(cb.owner.cannonDamage || 20);
          spawnSplash(cb.mesh.position.x, cb.mesh.position.z, t);
          scene.remove(cb.mesh);
          cannonballs.splice(i, 1);
          if (tgt === player) {
            showMessage('船体被击中！我们正在进水！');
            if (player.hp <= 0) setTimeout(() => endGame(false), 2500);
          } else if (tgt.hp <= 0) {
            sunkCount++;
            gold += 50;
            showMessage('💀 击沉敌船！+50 金币');
          }
          break;
        }
      }
    }

    // --- context prompts ---
    if (msgTimer <= 0) {
      if (nearPort()) showMessage('🏘️ 港口 — 按 F 靠港交易（修理 / 升级 / 造新船）', 0.5);
      else if (nearExtraction()) showMessage('🛶 撤离点 — 按 F 带着战利品撤离！', 0.5);
      else if (nearestTreasure()) showMessage('X marks the spot — 按 F 挖掘宝藏！', 0.5);
    }

    // --- HUD ---
    hud.gold.textContent = gold;
    hud.sunk.textContent = sunkCount;
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
