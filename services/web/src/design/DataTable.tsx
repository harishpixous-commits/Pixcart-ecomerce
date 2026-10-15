import { useCallback, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import './DataTable.css';

export type SortDirection = 'asc' | 'desc';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Plain-text projection used by export and by the sort comparator. */
  value?: (row: T) => string | number;
  sortable?: boolean;
  align?: 'start' | 'end';
  width?: string;
  /** Hides the column below the desktop breakpoint unless the user adds it back. */
  secondary?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  caption: string;
  /** Keyset pagination — §8.3: "Load more", never page numbers. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  /** Bulk-select with an action bar (§8.3). */
  selectable?: boolean;
  onSelectionChange?: (keys: string[]) => void;
  /** Rendered inside the bulk action bar when at least one row is selected. */
  bulkActions?: ReactNode;
  /** Export honours role gates (§8.3) — supply only when the role may export. */
  onExport?: () => void;
  exportLabel?: string;
  /** Row density toggle (§8.3). */
  denseByDefault?: boolean;
  emptyMessage?: string;
  sort?: { key: string; direction: SortDirection };
  onSortChange?: (key: string, direction: SortDirection) => void;
  /** Server-side sorting: omit local sorting. */
  manualSort?: boolean;
}

const DENSITIES = ['comfortable', 'compact'] as const;
type Density = (typeof DENSITIES)[number];

/**
 * §8.3 tables: sticky header, keyset pagination ("Load more"), whitelisted column
 * sort, row density toggle, bulk-select with an action bar, export honouring role
 * gates. Rendered as a real `<table>` because §8.4 requires data tables to be tables.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  selectable = false,
  onSelectionChange,
  bulkActions,
  onExport,
  exportLabel = 'Export',
  denseByDefault = false,
  emptyMessage = 'No rows to show',
  sort,
  onSortChange,
  manualSort = false,
}: DataTableProps<T>) {
  const [density, setDensity] = useState<Density>(denseByDefault ? 'compact' : 'comfortable');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localSort, setLocalSort] = useState<{ key: string; direction: SortDirection } | null>(null);
  const captionId = useId();

  const activeSort = sort ?? localSort;

  const sorted = useMemo(() => {
    if (manualSort || !activeSort) return rows;
    const col = columns.find((c) => c.key === activeSort.key);
    if (!col?.value) return rows;
    const dir = activeSort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.value!(a);
      const bv = col.value!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, activeSort, columns, manualSort]);

  const toggleSort = useCallback(
    (key: string) => {
      const col = columns.find((c) => c.key === key);
      if (!col?.sortable) return;
      const next: SortDirection =
        activeSort?.key === key && activeSort.direction === 'asc' ? 'desc' : 'asc';
      if (onSortChange) onSortChange(key, next);
      else setLocalSort({ key, direction: next });
    },
    [columns, activeSort, onSortChange],
  );

  const allSelected = sorted.length > 0 && sorted.every((r) => selected.has(rowKey(r)));

  const setAll = (checked: boolean) => {
    const next = checked ? new Set(sorted.map(rowKey)) : new Set<string>();
    setSelected(next);
    onSelectionChange?.([...next]);
  };

  const toggleRow = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
    onSelectionChange?.([...next]);
  };

  const handleExport = () => {
    if (!onExport) return;
    onExport();
  };

  return (
    <div className="px-table-wrap">
      <div className="px-table-toolbar">
        <div className="px-table-toolbar__left">
          <span className="px-table-count px-num">
            {sorted.length} {sorted.length === 1 ? 'row' : 'rows'}
          </span>
        </div>
        <div className="px-table-toolbar__right">
          <div className="px-density" role="group" aria-label="Row density">
            {DENSITIES.map((d) => (
              <button
                key={d}
                type="button"
                className={`px-density__btn ${density === d ? 'is-active' : ''}`}
                aria-pressed={density === d}
                onClick={() => setDensity(d)}
              >
                {d === 'comfortable' ? 'Comfortable' : 'Compact'}
              </button>
            ))}
          </div>
          {onExport && (
            <button type="button" className="px-table-export" onClick={handleExport}>
              <Download size={16} aria-hidden="true" />
              {exportLabel}
            </button>
          )}
        </div>
      </div>

      {selectable && selected.size > 0 && (
        <div className="px-bulk-bar" role="region" aria-label="Bulk actions">
          <span className="px-num">{selected.size} selected</span>
          <div className="px-bulk-bar__actions">
            {bulkActions}
            <button type="button" className="px-bulk-bar__clear" onClick={() => setAll(false)}>
              Clear selection
            </button>
          </div>
        </div>
      )}

      <div className="px-table-scroll">
        <table className={`px-table px-table--${density}`}>
          <caption id={captionId} className="px-visually-hidden">
            {caption}
          </caption>
          <thead className="px-table__head">
            <tr>
              {selectable && (
                <th scope="col" className="px-table__select">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={allSelected}
                    onChange={(e) => setAll(e.target.checked)}
                  />
                </th>
              )}
              {columns.map((c) => {
                const isActive = activeSort?.key === c.key;
                const ariaSort = !c.sortable
                  ? undefined
                  : isActive
                    ? activeSort!.direction === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : 'none';
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={c.width ? { width: c.width } : undefined}
                    className={[
                      c.align === 'end' ? 'is-end' : '',
                      c.secondary ? 'is-secondary' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {c.sortable ? (
                      <button type="button" className="px-table__sort" onClick={() => toggleSort(c.key)}>
                        <span>{c.header}</span>
                        {isActive ? (
                          activeSort!.direction === 'asc' ? (
                            <ChevronUp size={14} aria-hidden="true" />
                          ) : (
                            <ChevronDown size={14} aria-hidden="true" />
                          )
                        ) : (
                          <ChevronDown size={14} className="px-table__sort-idle" aria-hidden="true" />
                        )}
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  className="px-table__empty"
                  colSpan={columns.length + (selectable ? 1 : 0)}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              sorted.map((row) => {
                const key = rowKey(row);
                return (
                  <tr key={key} className={selected.has(key) ? 'is-selected' : undefined}>
                    {selectable && (
                      <td className="px-table__select">
                        <input
                          type="checkbox"
                          aria-label={`Select row ${key}`}
                          checked={selected.has(key)}
                          onChange={() => toggleRow(key)}
                        />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={[c.align === 'end' ? 'is-end' : '', c.secondary ? 'is-secondary' : '']
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="px-table-more">
          <button
            type="button"
            className="px-table-more__btn"
            onClick={onLoadMore}
            disabled={loadingMore}
            aria-busy={loadingMore || undefined}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
