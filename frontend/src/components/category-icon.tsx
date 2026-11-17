import { Baby, BookOpen, Dumbbell, Laptop, Shirt, ShoppingBasket, Sofa, Sparkles, Tag } from "lucide-react";

const ICONS: Record<string, typeof Tag> = {
  "mobiles-electronics": Laptop,
  fashion: Shirt,
  "home-kitchen": Sofa,
  "beauty-personal-care": Sparkles,
  grocery: ShoppingBasket,
  books: BookOpen,
  "toys-baby": Baby,
  "sports-fitness": Dumbbell,
};

export function CategoryIcon({ slug, className }: { slug: string; className?: string }) {
  const Icon = ICONS[slug] ?? Tag;
  return <Icon className={className} aria-hidden />;
}
