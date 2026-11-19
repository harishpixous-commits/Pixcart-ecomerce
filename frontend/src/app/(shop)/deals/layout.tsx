import type { Metadata } from "next";

export const metadata: Metadata = { title: "Today's Deals", description: "Lightning deals, deals of the day and limited time offers from verified sellers." };

export default function DealsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
