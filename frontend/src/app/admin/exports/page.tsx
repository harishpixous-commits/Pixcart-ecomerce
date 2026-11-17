"use client";

import { ExportCenter } from "@/components/export-center";

export default function AdminExports() {
  return <ExportCenter base="/api/admin/exports" title="Exports" sub="Download orders, GST lines, returns, payouts, catalogue and more as CSV for your accountant or your own analysis." />;
}
