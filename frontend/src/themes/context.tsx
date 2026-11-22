"use client";

/*
 * The active storefront theme for client components: useTheme() for its data, colours and preview state,
 * useLayout() for the layout options shared screens read (with the owner's layout changes applied). Set once by the
 * shop layout (app/(shop)/layout.tsx). Outside the shop (admin, seller hub) the default theme is reported, so shared
 * components still render.
 */

import { createContext, useContext, useMemo } from "react";
import { THEMES, applyLayout, type ThemeState } from "@/themes/manifest";
import { DEFAULT_THEME, type ActiveTheme, type ThemeLayout } from "@/themes/types";

const fallback: ActiveTheme = {
  data: THEMES[DEFAULT_THEME],
  presetId: THEMES[DEFAULT_THEME].presets[0].id,
  colors: THEMES[DEFAULT_THEME].presets[0].colors,
  ink: THEMES[DEFAULT_THEME].tokens.ink,
  preview: false,
};

const Ctx = createContext<ActiveTheme>(fallback);

export function ThemeProvider({ state, children }: { state: ThemeState; children: React.ReactNode }) {
  const layoutKey = JSON.stringify(state.layout ?? {});
  const value = useMemo<ActiveTheme>(() => {
    const base = THEMES[state.id] ?? fallback.data;
    const overrides = state.layout && Object.keys(state.layout).length ? state.layout : undefined;
    return {
      data: overrides ? { ...base, layout: applyLayout(base.layout, overrides) } : base,
      presetId: state.presetId, colors: state.colors, ink: state.ink, preview: state.preview, layoutOverrides: overrides,
    };
    // layoutKey stands for state.layout's contents
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.id, state.presetId, state.colors, state.ink, state.preview, layoutKey]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ActiveTheme {
  return useContext(Ctx);
}

export function useLayout(): ThemeLayout {
  return useContext(Ctx).data.layout;
}
