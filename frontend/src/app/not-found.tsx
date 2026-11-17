import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="font-display text-6xl font-bold text-peacock">404</p>
      <p className="text-lg">This page does not exist or the product is no longer sold.</p>
      <Link href="/" className="font-semibold text-peacock hover:underline">Go to the home page</Link>
    </div>
  );
}
