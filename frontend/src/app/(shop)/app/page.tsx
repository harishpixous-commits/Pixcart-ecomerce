import type { Metadata } from "next";
import { AppPage } from "./app-page";

export const metadata: Metadata = { title: "Get the app", description: "Install the shop's app on Android or iPhone: the same account, cart and orders, full screen and faster." };

export default function GetTheAppPage() {
  return <AppPage />;
}
