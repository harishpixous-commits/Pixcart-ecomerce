import { redirect } from "next/navigation";

// The returns policy is edited in Admin → Storefront → Pages.
export default function ReturnsHelp() {
  redirect("/pages/returns-policy");
}
