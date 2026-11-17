"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProductEditor } from "@/components/product-editor";
import { ErrorNote, PageLoader } from "@/components/ui";
import { api } from "@/lib/api";
import type { SellerProduct } from "@/lib/types";

export default function EditProductPage() {
  const { id } = useParams<{ id: string }>();
  const [p, setP] = useState<SellerProduct | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SellerProduct>(`/api/seller/products/${id}`).then(setP).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <ErrorNote message={error} />;
  if (!p) return <PageLoader />;
  return <ProductEditor key={`${p.updated_at}-${p.status}`} product={p} onSaved={setP} />;
}
