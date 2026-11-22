"use client";

/*
 * Every theme's components (header, footer, phone tab bar, product tile), for the shop. Kept apart from
 * manifest.ts (data only) so server code and the admin picker never load theme components they don't use.
 */

import { bazaarSlots } from "@/themes/bazaar/slots";
import { classicSlots } from "@/themes/classic/slots";
import { useTheme } from "@/themes/context";
import { freshSlots } from "@/themes/fresh/slots";
import { luxeSlots } from "@/themes/luxe/slots";
import type { ThemeId, ThemeSlots } from "@/themes/types";

export const SLOTS: Record<ThemeId, ThemeSlots> = {
  classic: classicSlots,
  bazaar: bazaarSlots,
  fresh: freshSlots,
  luxe: luxeSlots,
};

export function useSlots(): ThemeSlots {
  return SLOTS[useTheme().data.id] ?? classicSlots;
}
