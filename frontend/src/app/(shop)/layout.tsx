import { MobileTabBar, ShopFooter, ShopHeader } from "@/components/shop-chrome";

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ShopHeader />
      <main className="mx-auto min-h-[60vh] max-w-shop px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      <ShopFooter />
      <MobileTabBar />
    </>
  );
}
