import { notFound } from "next/navigation";

/** Unknown addresses under /delivery get this area's own "not found" page, inside its menu and header. */
export default function Missing(): never {
  notFound();
}
