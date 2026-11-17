"use client";

import { ExportCenter } from "@/components/export-center";

export default function SellerExports() {
  return <ExportCenter base="/api/seller/exports" title="Reports and exports" sub="Download your orders, GST line items for GSTR-1, returns, statement and stock as CSV." />;
}
