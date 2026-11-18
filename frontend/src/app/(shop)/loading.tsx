/** Shown instantly while a storefront page loads: the outline of a product grid. */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-5 w-64 rounded" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="rounded-xl bg-white p-3">
            <div className="skeleton mb-3 aspect-square w-full rounded-lg" />
            <div className="skeleton mb-2 h-4 w-11/12 rounded" />
            <div className="skeleton mb-3 h-4 w-2/3 rounded" />
            <div className="skeleton h-5 w-1/3 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}
