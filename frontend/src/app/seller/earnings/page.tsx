import { redirect } from "next/navigation";

// Earnings moved into Payouts (balances, payouts and the full statement).
export default function EarningsPage() {
  redirect("/seller/payouts");
}
