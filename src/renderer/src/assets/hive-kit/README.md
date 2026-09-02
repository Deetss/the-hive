# The Hive — office floor asset kit

All art is generated from `hive-art.js` (no binary source of truth). Re-run the bake
script in the design page's project to regenerate every PNG after editing that file.

## Grid

| thing | size | notes |
| --- | --- | --- |
| tile | 16×16 | seamless; honeycomb pitch 12×14, odd columns offset +7y |
| bee sprite | 16×16 | anchor = bottom-centre of the 16×16 cell |
| sheet cell | 24×24 | bee inset +4x +6y, leaves headroom for the status chip |
| status chip | 14×12 | +2px tail, drawn 15px above the bee cell |
| desk | 32×26 | monitor occupies the top 10 rows |

## Files

- `bee_<status>.png` — 192×72. 8 frames across × 3 rows (down / right / up). Mirror
  the `right` row horizontally for `left`. Statuses: idle, thinking, working, moving,
  blocked, done, handoff.
- `bee_atlas.png` — 192×504. All seven sheets stacked in the order above.
- `status_chips.png` — 98×14. The seven chips in the same order, for UI use.
- `tileset_16.png` — 80×16. floor, wall, capped, wood, beam.
- `tileset_tiling_proof.png` — each tile repeated 4×4 to show the seams line up.
- `props_sheet.png` — 176×84. desk, vat, cabinet, plant, whiteboard, mug.
- `scene_frame.png` / `scene_frame-2x.png` — reference still of the assembled floor.
- `palette.png` — 192×8. One 8px swatch per palette entry, in `PAL` key order.

## Animation timing

Authored at 12 fps. Frame index `i` of 8 samples the loop at
`t = i / 8 * L`, where `L` = 1.4s for most statuses, 0.7s for `moving`
and 0.24s for `blocked` (a fast shake). Loops are seamless: frame 8 == frame 0.

## Status vocabulary

| status | body | chip |
| --- | --- | --- |
| idle | slow bob, wings folded | ellipsis, shadow brown |
| thinking | hover lift, antennae twitch | cog, violet |
| working | fast bob, blurred wings, key sparks | keyboard, screen blue |
| moving | walk cycle, trailing dust | arrow, green |
| blocked | horizontal shake | exclamation, red — chip inverts on the beat |
| done | squash-pop, four sparkles, chip rises | check, green |
| handoff | honey token arcs out | droplet, honey |

## Palette

24 entries, one ramp. Wax `x X l p`, wood `d m M`, honey `h H`, chitin `k` with
`y Y` for the bee, plus `s S` screen, `g G` leaf, `u` plan violet, `r` alert,
`c` ok green, `w v` wing, `o n` outline and shadow.
