# Sea of Rouge 🏴‍☠️

A Sea of Thieves-inspired pirate sailing game built with [three.js](https://threejs.org/).
Sail an open ocean, hunt buried treasure, battle enemy ships, upgrade your vessel at the
port, and escape through the extraction point with your loot.

## Play

```bash
npm install
npm start          # serves http://localhost:8080 (static files + WebSocket)
```

Open http://localhost:8080 and choose **单人航行** (solo vs AI) or **🌐 多人联机**
(io-style multiplayer — every connected player shares the same sea, leaderboard included).
For solo play only, any static file server (e.g. `python -m http.server 8080`) also works.

> An internet connection is required (three.js is loaded from a CDN via import map).

## Multiplayer

- `server.js` is the authoritative server: it relays player state at 10 Hz, simulates
  all cannonballs at 30 Hz, and resolves hits with an oriented-bounding-box (OBB) test
  (plus near-miss splash damage). Sinking a player earns +100 gold; sunk ships respawn.
- The world uses a fixed seed, so every client generates identical islands, port,
  treasures, and the extraction point.

## Controls

| Input | Action |
| --- | --- |
| `W` / `S` | Raise / lower sails (3 speed levels) |
| `A` / `D` | Steer the rudder |
| `Space` | Fire a broadside (both sides) |
| `F` | Interact: dig treasure · dock at port · extract |
| Mouse drag / wheel | Orbit / zoom camera |
| `Esc` | Leave the port shop |

## Features

- **Procedural ocean** — GPU wave shader (foam crests, sun glint, fog) with the same
  wave function sampled on the CPU so ships realistically ride the swell.
- **Sailing physics** — sail levels, inertia, wave pitch/roll, running aground.
- **Naval combat** — broadside cannons with ballistic cannonballs, muzzle flashes,
  splashes, sinking animations, and enemy AI that chases, circles, and fires back.
- **Treasure hunting** — X marks the spot on 7 scattered islands; dig up gold.
- **Port & shipyard** — repair your hull, upgrade hull/cannons/sails (3 levels each),
  and build new ship classes (Sloop → Brigantine → Man o' War).
- **Extraction point** — reach the blue beacon to bank your gold and win.
- **HUD** — compass ribbon, hull bar, gold/sunk counters, sail pips, and a live
  minimap showing islands, treasures, enemies, the port, and the extraction point.

## Files

- `index.html` — page, HUD, shop UI, styles
- `main.js` — the entire game (scene, ocean shader, ships, AI, shop, minimap)
- `deploy.sh` — helper script to push this project to GitHub
