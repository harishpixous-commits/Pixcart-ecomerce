"use client";

import { CouponManager } from "@/components/coupons";

export default function AdminCoupons() {
  return <CouponManager base="/api/admin/coupons" admin />;
}
