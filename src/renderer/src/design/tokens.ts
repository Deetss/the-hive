// Design tokens — single source of truth. Mirrors tokens.css for non-styled consumers (Pixi).
// Any change here must also update tokens.css.

export const colors = {
  cream: {
    50: 0xfefcf4,
    100: 0xfaf2dd,
    200: 0xf2e6c6,
    300: 0xe9d9ad
  },
  paper: {
    100: 0xfefdf7,
    200: 0xf6ecd3
  },
  ink: {
    900: 0x2a1d08,
    700: 0x4c3814,
    500: 0x6f5628,
    300: 0xa6893f,
    100: 0xe7d6a6
  },
  // Brand color calibrations: Blue #274579, Green #75aa5c, Cream #f5f9e7, Red #ef3e2d, Salmon #f47d55, Gray #6e7167
  accent: {
    coral: 0xef3e2d,
    coralLight: 0xfce2df,
    mint: 0x75aa5c,
    mintLight: 0xe5f2df,
    sky: 0x274579,
    skyLight: 0xdde6f5,
    lemon: 0xd4a02a,
    lemonLight: 0xfaf1d6,
    lilac: 0x7c6db2,
    lilacLight: 0xede8f8,
    peach: 0xf47d55,
    peachLight: 0xfde8e0
  },
  status: {
    idle: 0x6e7167,
    thinking: 0x274579,
    working: 0xd4a02a,
    blocked: 0xef3e2d,
    success: 0x75aa5c,
    ghost: 0xded2ae
  },
  world: {
    grassLight: 0xd4eab0,
    grassDark: 0xb5d589,
    woodLight: 0xe5c896,
    woodDark: 0xc9a66b,
    path: 0xe8d8b0,
    wall: 0x8b6f47
  }
} as const;

export const space = {
  0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 48, 8: 64
} as const;

export const type = {
  display: '"Press Start 2P", monospace',
  ui: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace'
} as const;

export const tileSize = 32; // px — the world is built from 32×32 tiles

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

export const accentByName: Record<AccentColorName, number> = {
  coral: colors.accent.coral,
  mint:  colors.accent.mint,
  sky:   colors.accent.sky,
  lemon: colors.accent.lemon,
  lilac: colors.accent.lilac,
  peach: colors.accent.peach
};

export const accentLightByName: Record<AccentColorName, number> = {
  coral: colors.accent.coralLight,
  mint:  colors.accent.mintLight,
  sky:   colors.accent.skyLight,
  lemon: colors.accent.lemonLight,
  lilac: colors.accent.lilacLight,
  peach: colors.accent.peachLight
};

// Convert 0xRRGGBB to "#RRGGBB"
export function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0').toUpperCase();
}
