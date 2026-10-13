/**
 * Visual identity for shelves, categories and items.
 *
 * The API stores palette and icon KEYS, never raw hex values or arbitrary strings. That keeps every colour inside a
 * set the web app has tested for contrast in both themes (Galvanized and Night crib), and means a bad client can
 * never persist something the UI cannot render. The web app mirrors these two lists in src/lib/appearance.tsx.
 */
import { Type } from '@sinclair/typebox';

export const PALETTE = ['maroon', 'amber', 'teal', 'slate', 'forest', 'indigo', 'rose', 'copper', 'sky', 'olive', 'plum', 'graphite'] as const;
export const ICONS = [
  'package', 'boxes', 'layers', 'wrench', 'hammer', 'drill', 'zap', 'plug', 'cable', 'lightbulb', 'hard-hat', 'shield',
  'glasses', 'shirt', 'truck', 'paintbrush', 'flask', 'droplet', 'flame', 'scissors', 'ruler', 'gauge', 'thermometer',
  'key', 'tag', 'wheat', 'shopping-basket', 'utensils', 'sprout', 'pill', 'cog', 'warehouse',
] as const;

export type PaletteKey = typeof PALETTE[number];
export type IconKey = typeof ICONS[number];

const lit = <T extends readonly string[]>(xs: T) => Type.Union(xs.map((x) => Type.Literal(x)) as never) as never as ReturnType<typeof Type.String>;
/** Optional and nullable so a PATCH can clear the value. */
export const ColorField = Type.Optional(Type.Union([lit(PALETTE), Type.Null()]));
export const IconField = Type.Optional(Type.Union([lit(ICONS), Type.Null()]));
