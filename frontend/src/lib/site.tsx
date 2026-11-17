"use client";

import { FALLBACK_SITE } from "@/lib/site-defaults";

import { createContext, useContext } from "react";
import type { Site } from "./types";

const SiteCtx = createContext<Site>(FALLBACK_SITE);

export function SiteProvider({ site, children }: { site: Site; children: React.ReactNode }) {
  return <SiteCtx.Provider value={site}>{children}</SiteCtx.Provider>;
}

export function useSite() {
  return useContext(SiteCtx);
}
