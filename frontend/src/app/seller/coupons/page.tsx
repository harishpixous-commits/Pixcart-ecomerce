"use client";

import { CouponManager } from "@/components/coupons";

export default function SellerCoupons() {
  return <CouponManager base="/api/seller/coupons" />;
}
