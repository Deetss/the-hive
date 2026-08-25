# The Hive: Zerg reskin of Munder Difflin

A fork of [munder-difflin](https://github.com/chaitanyagiri/munder-difflin) reskinned as a
StarCraft Zerg swarm. The upstream harness runs a team of CLI coding agents on your machine,
visualized as workers on a pixel office floor with a "GOD agent" orchestrating them. This fork
keeps the engine and reskins the fiction: the office becomes a Hive cluster, the boss becomes
the Overmind, the workers become broods.

Upstream is kept as the `upstream` git remote so their engine improvements can be pulled in.

## Why this is tractable

The scene is already theme-pluggable. A theme is a data contract (`ThemeConfig` in
`src/renderer/src/scene/office/themeRegistry.ts`): a Tiled map, tilesets, seat/coffee/errand
coordinates, a palette, and a cast. The engine (renderer, BFS pathfinding, camera, sprite
animation) is fully generic. Upstream already registered a second theme (Brooklyn 99) this way.
Character art is procedural (`portraitArt.ts` paints each unit from a `Recipe`), so a Zerg cast
is authored in code, no external spritesheets required for the units themselves.

## Concept map

| Munder Difflin | The Hive |
| --- | --- |
| Munder Difflin (the app) | The Hive |
| Michael (the GOD orchestrator) | The Overmind |
| Michael's prep assistant | Cerebrate (enriches tasks before the Overmind runs them) |
| Worker agents / office cast | Broods (individual Zerg units) |
| The office floor (Tiled map) | The Hive cluster, grown on creep |
| Desks / PCs (workstations) | Hatchery chambers where broods work |
| Coffee economy (mugs, machine, sink) | Biomass economy (drones gather, units regenerate) |
| Cafeteria / break room | The spawning pool |
| Flying message envelopes | Overlords ferrying signals between broods |
| Kanban notes (todo/doing/blocked/done) | Egg and larva states |
| Founding-supporter wall / marketing | Stripped (personal fork) |

## The brood roster

Fifteen units mirror the fifteen office cast slots. The Overmind fills the god seat.

| Unit | Dev role flavor | Accent |
| --- | --- | --- |
| Overmind | Orchestrator (god seat) | deep violet |
| Queen | Larva injection, brood management | magenta |
| Drone | The worker/builder | tan |
| Zergling | Fast, eager junior | crimson |
| Hydralisk | Ranged, versatile generalist | green |
| Roach | Tanky, regenerates (resilient work) | brown |
| Overlord | Transport, supply, message ferry | violet |
| Mutalisk | Flyer, harasser | teal |
| Ultralisk | Heavy hitter | slate |
| Baneling | Volatile QA (blows things up on contact) | acid yellow |
| Infestor | Control, infestation | sickly green |
| Corruptor | Anti-air specialist | purple |
| Broodlord | Siege | bone |
| Viper | Utility, abduction | olive |
| Lurker | Ambush | dark red |

## Phased roadmap

- **Phase 0 (foundation, done):** Fork set up locally on branch `zerg-reskin`, upstream retained.
  Register a `zerg` theme and a Hive entry in the theme picker. Placeholder art reuses the office
  map + cast (exactly how Brooklyn 99 shipped), so the Hive floor is selectable and runnable.
- **Phase 1 (app rebrand):** Munder Difflin to The Hive across the app name, window title, update
  filenames, and user-facing copy. Mechanical, gated by `npm run typecheck` plus a grep sweep.
- **Phase 2 (Overmind rename):** Michael to the Overmind. Careful: the name is woven through
  model-facing prompts (`hive.ts`, `agentProvider.ts`) and component names (`MichaelBooting.tsx`,
  `RealtimeMichaelToggle.tsx`). Its own phase so the prompt rewrites get review.
- **Phase 3 (procedural Zerg cast):** Author the brood roster in a `zergCast.ts` plus new draw
  primitives in `portraitArt.ts` (carapace, spikes, glowing eyes, no human face). Replaces the
  office cast for the zerg theme. Gated by a running dev build.
- **Phase 4 (Hive art):** Hand-authored Tiled hive map (creep floor, hatchery chambers, spawning
  pool) and a Zerg tileset. The long pole: needs sourced or drawn pixel assets. This is the
  "full art" target.
- **Phase 5 (improve):** Engine and UX improvements beyond the reskin. Wishlist TBD.

## Running it

```
npm install        # native rebuild (electron-rebuild, node-pty) runs in postinstall
npm run dev         # launch the Electron app
npm run typecheck   # gate for code phases
```
