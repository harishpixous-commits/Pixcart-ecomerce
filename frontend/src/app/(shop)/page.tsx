import { HomeSections } from "@/components/home-sections";
import { serverGet } from "@/lib/server-api";
import type { CategoryNode, HomeSectionData } from "@/lib/types";


export default async function HomePage() {
  const data = await serverGet<{ sections: HomeSectionData[]; categories: CategoryNode[] }>("/api/home", 15).catch(() => null);
  if (!data) {
    return <p className="py-20 text-center text-ink-soft">The store is waking up. Refresh the page in a moment.</p>;
  }
  return <HomeSections sections={data.sections} />;
}
