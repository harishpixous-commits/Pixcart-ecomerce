/** Shown instantly while a product page loads: gallery, details and buy box in their final places. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading product">
      <div className="skeleton h-4 w-72 rounded" />
      <div className="grid gap-6 rounded-xl bg-white p-4 sm:p-6 lg:grid-cols-[1.1fr_1fr] xl:grid-cols-[1fr_1fr_300px]">
        <div className="flex gap-3">
          <div className="hidden w-16 flex-col gap-2 sm:flex">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton aspect-square w-full rounded-lg" />)}
          </div>
          <div className="skeleton aspect-square flex-1 rounded-xl" />
        </div>
        <div className="flex flex-col gap-3">
          <div className="skeleton h-4 w-32 rounded" />
          <div className="skeleton h-8 w-full rounded" />
          <div className="skeleton h-8 w-3/4 rounded" />
          <div className="skeleton h-4 w-48 rounded" />
          <div className="skeleton mt-2 h-10 w-56 rounded" />
          <div className="skeleton h-20 w-full rounded-lg" />
          <div className="skeleton h-14 w-full rounded-lg" />
          <div className="skeleton h-32 w-full rounded-lg" />
        </div>
        <div className="flex flex-col gap-3 rounded-xl border border-line p-4 lg:col-start-2 xl:col-start-auto">
          <div className="skeleton h-8 w-32 rounded" />
          <div className="skeleton h-16 w-full rounded" />
          <div className="skeleton h-11 w-full rounded-lg" />
          <div className="skeleton h-11 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
