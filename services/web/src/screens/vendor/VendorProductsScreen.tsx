/**
 * Vendor product listings (FR-VEN-003).
 *
 * The list, the single-listing fetch and both writes go through the typed client
 * (`api.vendorProducts`, `api.vendorProduct`, `api.patchVendorProduct`,
 * `api.createVendorProduct`). Search and state filters live in the URL so a
 * filtered view is shareable and survives Back (§8.3); the filter itself runs
 * client-side over the one fetched page because the client's list call takes no
 * query parameters.
 *
 * Money note: the BFF's listing rows are the one vendor payload that carries
 * money as DECIMAL(10,2) rupee strings (raw cat_listing columns — see
 * services/bff/src/repos/vendor.ts, listVendorListings). They are converted to
 * integer paise exactly, at the edge, and every write sends `*Paise` integers.
 *
 * Regulated edits (title, MRP, HSN) move a listing back to SUBMITTED for
 * re-approval server-side (BRU-02); the success toast reports whatever the
 * server answered — `revisionNo` and `regulated` — rather than assuming.
 */
import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Eye, Pencil, Plus } from 'lucide-react';
import { Badge, Button, DataTable, Modal, SelectField, TextField, useToast } from '../../design';
import type { BadgeTone, Column } from '../../design';
import { api } from '../../lib/api';
import { dateTime, money } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { describeError, useAsync } from '../lib/useAsync';
import { humanise, problemFields, type ItemsResponse } from './common';
import './vendor.css';

/**
 * Wire row for GET /vendor/listings. Field names mirror the BFF's listing query
 * (listVendorListings): snake_case cat_listing columns, money as rupee strings.
 */
interface VendorListingRow {
  id: string;
  product_id: string;
  title: string;
  mrp: string;
  price: string;
  state: string;
  hsn_code: string;
  attributes: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** What POST /vendor/listings/:id/revisions answers in the BFF today. */
interface RevisionResult {
  revisionNo: number;
  regulated: boolean;
}

/** V001 ck_listing_state vocabulary. */
const LISTING_STATES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LIVE', 'PAUSED', 'ARCHIVED'] as const;

const LISTING_STATE_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'progress',
  APPROVED: 'info',
  REJECTED: 'danger',
  LIVE: 'success',
  PAUSED: 'warning',
  ARCHIVED: 'neutral',
};

function listingTone(state: string): BadgeTone {
  return LISTING_STATE_TONE[state] ?? 'neutral';
}

/** Exact rupees→paise on a decimal string: "1234.56" → 123456, no float arithmetic. */
function rupeesToPaise(dec: string): number {
  const [whole, frac = ''] = dec.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/** Parse user input as a non-negative rupee amount; null when it is not valid. */
function parseRupees(value: string): number | null {
  const v = value.trim();
  return /^\d+(\.\d{1,2})?$/.test(v) ? rupeesToPaise(v) : null;
}

/** Form draft. `mrp`/`price` are rupee strings for the inputs; sent as paise. */
interface ListingDraft {
  id: string;
  title: string;
  mrp: string;
  price: string;
  hsn: string;
}

/** `GET /categories` tree node — only `id`/`name` are read here. */
interface CategoryNode {
  id: string;
  name: string;
  children?: CategoryNode[];
}

/**
 * Depth-first flatten so a nested tree becomes one flat options list; deeper
 * categories are indented so the hierarchy stays readable in a native select.
 */
function flattenCategories(nodes: CategoryNode[], depth = 0): { value: string; label: string }[] {
  return nodes.flatMap((n) => [
    { value: n.id, label: `${'  '.repeat(depth)}${depth > 0 ? '└ ' : ''}${n.name}` },
    ...flattenCategories(n.children ?? [], depth + 1),
  ]);
}

function toDraft(r: VendorListingRow): ListingDraft {
  return { id: r.id, title: r.title, mrp: r.mrp, price: r.price, hsn: r.hsn_code };
}

const EMPTY_DRAFT: ListingDraft = { id: '', title: '', mrp: '', price: '', hsn: '' };

/* ------------------------------------------------------------------ *
 * Create / edit modal — one form, two modes
 * ------------------------------------------------------------------ */

function ListingFormModal({
  mode,
  draft,
  onClose,
  onSaved,
}: {
  mode: 'edit' | 'create';
  draft: ListingDraft;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [mrp, setMrp] = useState(draft.mrp);
  const [price, setPrice] = useState(draft.price);
  const [hsn, setHsn] = useState(draft.hsn);
  const [categoryId, setCategoryId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);

  // The category is a create-only field (an edit is a revision and never moves
  // the listing between categories), so the tree is fetched only in that mode.
  const categories = useAsync<{ items: CategoryNode[] } | null>(
    async (signal) =>
      mode === 'create' ? ((await api.categories(signal)) as { items: CategoryNode[] }) : null,
    [mode],
  );
  const categoryOptions = flattenCategories(categories.data?.items ?? []);

  const mrpPaise = parseRupees(mrp);
  const pricePaise = parseRupees(price);

  const mrpClientError = mrp.trim() !== '' && mrpPaise === null ? 'Enter an amount in rupees, e.g. 999 or 999.50' : undefined;
  const priceClientError =
    price.trim() === ''
      ? undefined
      : pricePaise === null
        ? 'Enter an amount in rupees, e.g. 999 or 999.50'
        : mrpPaise !== null && pricePaise > mrpPaise
          ? 'Price cannot exceed MRP'
          : undefined;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (mrpPaise === null || pricePaise === null) {
      setFormError({ message: 'Enter MRP and price in rupees (up to 2 decimal places) before saving.' });
      return;
    }
    if (mode === 'create' && categoryId === '') {
      setFormError({ message: 'Choose a category for the new listing.' });
      return;
    }
    setSubmitting(true);
    setServerErrors({});
    setFormError(null);
    const body = { title: title.trim(), mrpPaise, pricePaise, hsnCode: hsn.trim() };
    try {
      if (mode === 'edit') {
        const res = (await api.patchVendorProduct(draft.id, body)) as RevisionResult;
        onSaved(
          res.regulated
            ? `Saved as revision ${res.revisionNo}. A regulated field changed, so the listing is back in the admin approval queue.`
            : `Saved as revision ${res.revisionNo}.`,
        );
      } else {
        // The BFF keys the create payload by `categoryId`; the product row it
        // inserts has a NOT NULL category (V001 cat_product.category_id).
        await api.createVendorProduct({ ...body, categoryId });
        onSaved('Listing created.');
      }
    } catch (err) {
      const fields = problemFields(err);
      if (fields) setServerErrors(fields);
      const { message, traceId } = describeError(err);
      setFormError({ message, traceId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'edit' ? 'Edit listing' : 'Create listing'}
      description={
        mode === 'edit'
          ? 'Changing the title, MRP or HSN is a regulated change: the listing re-enters admin approval before it can go live again.'
          : 'All amounts are in rupees; the server stores them as integer paise.'
      }
      size="md"
    >
      <form className="px-form" onSubmit={onSubmit} noValidate>
        {formError && (
          <div className="px-screenstate px-screenstate--error" role="alert">
            <AlertTriangle size={20} aria-hidden="true" />
            <p className="px-screenstate__msg">{formError.message}</p>
            {formError.traceId && (
              <details className="px-screenstate__details">
                <summary>Technical details</summary>
                <p>
                  Trace ID: <code className="px-num">{formError.traceId}</code>
                </p>
              </details>
            )}
          </div>
        )}

        <TextField
          label="Title"
          name="listing-title"
          required
          value={title}
          onValueChange={setTitle}
          serverError={serverErrors.title}
        />
        {mode === 'create' && (
          <SelectField
            label="Category"
            name="listing-category"
            required
            value={categoryId}
            onValueChange={setCategoryId}
            options={categoryOptions}
            hint={
              categories.status === 'loading'
                ? 'Loading categories…'
                : categoryOptions.length === 0
                  ? 'No categories are available yet.'
                  : 'The listing is filed under this category for search and browse.'
            }
            error={serverErrors.categoryId}
          />
        )}
        <TextField
          label="MRP (₹)"
          name="listing-mrp"
          inputMode="decimal"
          required
          value={mrp}
          onValueChange={setMrp}
          hint="Rupees, up to 2 decimal places."
          error={mrpClientError}
          serverError={serverErrors.mrpPaise}
        />
        <TextField
          label="Price (₹)"
          name="listing-price"
          inputMode="decimal"
          required
          value={price}
          onValueChange={setPrice}
          hint="Rupees, up to 2 decimal places."
          error={priceClientError}
          serverError={serverErrors.pricePaise}
        />
        <TextField
          label="HSN code"
          name="listing-hsn"
          value={hsn}
          onValueChange={setHsn}
          serverError={serverErrors.hsnCode}
        />

        <div className="px-form__actions">
          {/* Disabled only while submitting — §8.3. */}
          <Button type="submit" variant="primary" loading={submitting}>
            {mode === 'edit' ? 'Save changes' : 'Create listing'}
          </Button>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * View modal
 * ------------------------------------------------------------------ */

function ViewModal({
  id,
  onClose,
  onEdit,
}: {
  id: string | null;
  onClose: () => void;
  onEdit: (draft: ListingDraft) => void;
}) {
  const viewed = useAsync<VendorListingRow | null>(
    async (signal) => (id ? ((await api.vendorProduct(id, signal)) as VendorListingRow) : null),
    [id],
  );
  const d = viewed.data;

  return (
    <Modal
      open={id !== null}
      onClose={onClose}
      title="Listing details"
      size="md"
      footer={
        <>
          {d && (
            <Button variant="secondary" onClick={() => onEdit(toDraft(d))}>
              Edit
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {viewed.status === 'loading' && <ScreenLoading label="Loading listing" />}
      {viewed.status === 'error' && <ScreenError error={viewed.error} onRetry={viewed.reload} />}
      {d && (
        <dl className="px-dl">
          <dt>Title</dt>
          <dd>{d.title}</dd>
          <dt>State</dt>
          <dd>
            <Badge tone={listingTone(d.state)}>{humanise(d.state)}</Badge>
          </dd>
          <dt>MRP</dt>
          <dd className="px-num">{money(rupeesToPaise(d.mrp))}</dd>
          <dt>Price</dt>
          <dd className="px-num">{money(rupeesToPaise(d.price))}</dd>
          <dt>HSN code</dt>
          <dd>{d.hsn_code || '—'}</dd>
          <dt>Listing ID</dt>
          <dd>
            <code className="px-num">{d.id}</code>
          </dd>
          <dt>Product ID</dt>
          <dd>
            <code className="px-num">{d.product_id}</code>
          </dd>
          <dt>Created</dt>
          <dd>{dateTime(d.created_at)}</dd>
          <dt>Updated</dt>
          <dd>{dateTime(d.updated_at)}</dd>
        </dl>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export function VendorProductsScreen() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const stateFilter = params.get('state') ?? '';
  const toast = useToast();

  const [viewId, setViewId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ListingDraft | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const listings = useAsync<ItemsResponse<VendorListingRow>>(
    async (signal) => (await api.vendorProducts(signal)) as ItemsResponse<VendorListingRow>,
    [],
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    const items = listings.data?.items ?? [];
    const needle = q.trim().toLowerCase();
    return items.filter((r) => {
      const matchesQ =
        needle === '' ||
        r.title.toLowerCase().includes(needle) ||
        r.id.toLowerCase().includes(needle) ||
        r.hsn_code.toLowerCase().includes(needle);
      const matchesState = stateFilter === '' || r.state === stateFilter;
      return matchesQ && matchesState;
    });
  }, [listings.data, q, stateFilter]);

  const columns: Column<VendorListingRow>[] = [
    {
      key: 'title',
      header: 'Listing',
      sortable: true,
      value: (r) => r.title,
      render: (r) => r.title,
    },
    {
      key: 'state',
      header: 'State',
      value: (r) => r.state,
      render: (r) => <Badge tone={listingTone(r.state)}>{humanise(r.state)}</Badge>,
    },
    {
      key: 'mrp',
      header: 'MRP',
      align: 'end',
      sortable: true,
      value: (r) => rupeesToPaise(r.mrp),
      render: (r) => <span className="px-num">{money(rupeesToPaise(r.mrp))}</span>,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'end',
      sortable: true,
      value: (r) => rupeesToPaise(r.price),
      render: (r) => <span className="px-num">{money(rupeesToPaise(r.price))}</span>,
    },
    {
      key: 'hsn',
      header: 'HSN',
      secondary: true,
      value: (r) => r.hsn_code,
      render: (r) => r.hsn_code || '—',
    },
    {
      key: 'updated',
      header: 'Updated',
      secondary: true,
      sortable: true,
      value: (r) => r.updated_at,
      render: (r) => dateTime(r.updated_at),
    },
    {
      key: 'actions',
      header: 'Actions',
      render: (r) => (
        <div className="px-row-actions">
          <Button
            size="sm"
            icon={<Eye size={14} aria-hidden="true" />}
            onClick={() => setViewId(r.id)}
          >
            View
          </Button>
          <Button
            size="sm"
            icon={<Pencil size={14} aria-hidden="true" />}
            onClick={() => setEditDraft(toDraft(r))}
          >
            Edit
          </Button>
        </div>
      ),
    },
  ];

  const afterWrite = (message: string) => {
    toast.success(message);
    setEditDraft(null);
    setCreateOpen(false);
    listings.reload();
  };

  return (
    <div className="px-page">
      <PageHeader
        title="Products"
        description="Your listings and their approval state. Regulated edits (title, MRP, HSN) return a listing to admin approval."
        crumbs={[{ label: 'Vendor', to: '/vendor' }, { label: 'Products' }]}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setCreateOpen(true)}
          >
            Create listing
          </Button>
        }
      />

      <form
        className="px-filterbar"
        role="search"
        aria-label="Filter listings"
        onSubmit={(e) => e.preventDefault()}
      >
        <TextField
          label="Search listings"
          name="product-q"
          type="search"
          placeholder="Title, listing ID or HSN"
          value={q}
          onValueChange={(v) => setParam('q', v)}
        />
        <SelectField
          label="State"
          name="product-state"
          value={stateFilter}
          onValueChange={(v) => setParam('state', v)}
          options={[
            { value: '', label: 'All states' },
            ...LISTING_STATES.map((s) => ({ value: s, label: humanise(s) })),
          ]}
        />
      </form>

      {listings.status === 'loading' && !listings.data && <ScreenLoading label="Loading listings" />}
      {listings.status === 'error' && <ScreenError error={listings.error} onRetry={listings.reload} />}

      {listings.data &&
        (rows.length === 0 ? (
          listings.data.items.length === 0 ? (
            <ScreenEmpty
              title="No listings yet"
              description="Create your first listing to put a product up for sale."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create listing
                </Button>
              }
            />
          ) : (
            <ScreenEmpty
              title="No listings match your filters"
              description="Adjust the search or state filter to see more listings."
              action={
                <Button onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              }
            />
          )
        ) : (
          <DataTable
            caption="Your product listings"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}

      {viewId && (
        <ViewModal
          id={viewId}
          onClose={() => setViewId(null)}
          onEdit={(draft) => {
            setViewId(null);
            setEditDraft(draft);
          }}
        />
      )}
      {editDraft && (
        <ListingFormModal mode="edit" draft={editDraft} onClose={() => setEditDraft(null)} onSaved={afterWrite} />
      )}
      {createOpen && (
        <ListingFormModal mode="create" draft={EMPTY_DRAFT} onClose={() => setCreateOpen(false)} onSaved={afterWrite} />
      )}
    </div>
  );
}
