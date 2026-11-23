import { notFound } from "next/navigation";

/** Any address no shop page matches gets the shop's own "not found" page, inside the theme (not a bare page). */
export default function Missing(): never {
  notFound();
}
