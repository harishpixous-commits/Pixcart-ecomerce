import type { Metadata } from "next";
import { DeliveryApp } from "@/components/delivery/app";

export const metadata: Metadata = {
  title: { default: "Delivery partner", template: "%s | Delivery partner" },
  description: "Deliver orders near you on your own time and get paid every week.",
};

export default function DeliveryLayout({ children }: { children: React.ReactNode }) {
  return <DeliveryApp>{children}</DeliveryApp>;
}
