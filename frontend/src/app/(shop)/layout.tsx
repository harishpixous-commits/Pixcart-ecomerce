import { MobileTabBar, ShopFooter, ShopHeader } from "@/components/shop-chrome";
import { BackToTop } from "@/components/back-to-top";
import { CompareTray } from "@/components/compare";
import { ShopAssistant } from "@/components/shop-assistant/widget";

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ShopHeader />
      <main className="mx-auto min-h-[60vh] max-w-shop px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      <BackToTop />
      <ShopFooter />
      <MobileTabBar />
      <ShopAssistant />
      <CompareTray />
    </>
  );
}
