/**
 * Category management (FR-ADM-003).
 *
 * Data: `api.adminCategories` → GET /api/v1/admin/catalogue/categories →
 * a `{ items: Category[] }` tree (Category = contracts/dto.ts: id, parentId,
 * name, slug, children?, productCount?). NOTE: the BFF in this repository does
 * not yet register that GET route (routes/admin.ts only registers POST
 * /admin/categories and POST /admin/categories/:id/retire), so against this
 * BFF the screen renders the server's error verbatim — it does not fall back
 * to mock data. The create body mirrors the BFF's evidenced POST contract
 * { name, slug, parentId }; PATCH is typed by the web client
 * (api.patchCategory) and mirrors the same body.
 *
 * The parent selector offers ONLY categories that came back in the response —
 * never a hard-coded list. When editing, the category's own subtree is
 * excluded so a cycle cannot be offered (the tree builder links children by
 * parentId, and a cycle would produce an unrepresentable tree).
 *
 * Validation errors map onto fields (422 → ApiProblem.fields, §8.3); anything
 * else (slug taken, forbidden) is a form-level alert carrying the server's
 * message and trace id.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Pencil, Plus } from 'lucide-react';
import type { Category } from '@contracts/dto';
import { Button, Modal, TextField } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { number } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import type { ItemsResponse } from './common';
import './admin.css';

/* ------------------------------------------------------------------ *
 * Tree helpers
 * ------------------------------------------------------------------ */

interface FlatCategory {
  id: string;
  name: string;
  depth: number;
}

/** Depth-first flattening of the real response, for the parent selector. */
function flatten(cats: Category[], depth = 0, out: FlatCategory[] = []): FlatCategory[] {
  for (const c of cats) {
    out.push({ id: c.id, name: c.name, depth });
    if (c.children) flatten(c.children, depth + 1, out);
  }
  return out;
}

/** Every id in `cat`'s subtree, including itself — excluded when editing it. */
function subtreeIds(cat: Category, out = new Set<string>()): Set<string> {
  out.add(cat.id);
  if (cat.children) for (const ch of cat.children) subtreeIds(ch, out);
  return out;
}

/** One tree level. Rendered as real nested lists so the hierarchy is exposed to AT. */
function renderTree(nodes: Category[], onEdit: (c: Category) => void): ReactNode {
  return (
    <ul className="px-cat-tree">
      {nodes.map((c) => (
        <li key={c.id}>
          <div className="px-cat-tree__row">
            <span className="px-cat-tree__name">{c.name}</span>
            <code className="px-cat-tree__slug">/{c.slug}</code>
            {typeof c.productCount === 'number' && (
              <span className="px-cat-tree__count">{number(c.productCount)} live products</span>
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={<Pencil size={14} aria-hidden="true" />}
              onClick={() => onEdit(c)}
            >
              Edit {c.name}
            </Button>
          </div>
          {c.children && c.children.length > 0 && renderTree(c.children, onEdit)}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ *
 * Create / edit modal
 * ------------------------------------------------------------------ */

type FormMode = { kind: 'create' } | { kind: 'edit'; category: Category };

function CategoryModal({
  open,
  mode,
  categories,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: FormMode;
  categories: Category[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = mode.kind === 'edit' ? mode.category : null;

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [parentId, setParentId] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed the edit form from the real row each time the dialog opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== (editing?.id ?? '__create__')) {
    setSeededFor(editing?.id ?? '__create__');
    setName(editing?.name ?? '');
    setSlug(editing?.slug ?? '');
    setParentId(editing?.parentId ?? '');
    setFieldErrors({});
    setFormError(null);
  }

  const excluded = editing ? subtreeIds(editing) : new Set<string>();
  const parentOptions = flatten(categories)
    .filter((c) => !excluded.has(c.id))
    .map((c) => ({ value: c.id, label: `${'— '.repeat(c.depth)}${c.name}` }));

  const submit = async () => {
    if (submitting) return;

    // Client pre-checks mirror the server's own rule (repos/admin.ts):
    // slug must be lowercase alphanumeric with hyphens; anything else is
    // left to the server, which answers 422 with a field map (E-VAL-001).
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!slug.trim()) errs.slug = 'Slug is required';
    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;

    setSubmitting(true);
    try {
      const body = { name: name.trim(), slug: slug.trim(), parentId: parentId || undefined };
      if (mode.kind === 'edit') await api.patchCategory(mode.category.id, body);
      else await api.createCategory(body);
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ApiProblem) {
        if (err.status === 422 && err.fields) setFieldErrors(err.fields);
        setFormError({ message: err.problem.detail || err.problem.title, traceId: err.traceId });
      } else {
        setFormError({ message: 'Could not reach the server. Check your connection and try again.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <Modal
      open={open}
      onClose={submitting ? () => undefined : onClose}
      title={editing ? `Edit category: ${editing.name}` : 'New category'}
      description={
        editing
          ? 'Sends name, slug and parent to the server. The server confirms or refuses; nothing is applied until it answers.'
          : 'The server creates the category and returns its id. A slug can only be used once.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Create category'}
          </Button>
        </>
      }
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
          label="Name"
          name="cat-name"
          required
          value={name}
          onValueChange={setName}
          serverError={fieldErrors.name}
        />
        <TextField
          label="Slug"
          name="cat-slug"
          required
          value={slug}
          onValueChange={setSlug}
          hint="URL segment: lowercase letters, digits, hyphens"
          error={
            slug.trim() !== '' && !/^[a-z0-9-]+$/.test(slug.trim())
              ? 'Lowercase letters, digits and hyphens only (e.g. summer-sale)'
              : undefined
          }
          serverError={fieldErrors.slug}
        />
        {parentOptions.length > 0 && (
          <div className="px-field">
            <label className="px-field__label" htmlFor="f-cat-parent">
              Parent category
            </label>
            <select
              id="f-cat-parent"
              className="px-input px-input--select"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
            >
              <option value="">None (top level)</option>
              {parentOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="px-field__hint">Only categories from the loaded tree are offered.</p>
          </div>
        )}
        <div className="px-form__actions">
          <span className="px-form__aside">The server validates the final values.</span>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ *
 * Screen
 * ------------------------------------------------------------------ */

export function AdminCatalogueScreen() {
  const cats = useAsync<ItemsResponse<Category>>(
    async (signal) => (await api.adminCategories(signal)) as ItemsResponse<Category>,
    [],
  );
  const [modal, setModal] = useState<{ open: boolean; mode: FormMode }>({
    open: false,
    mode: { kind: 'create' },
  });

  const tree = cats.data?.items ?? [];

  return (
    <div className="px-page">
      <PageHeader
        title="Catalogue"
        description="The category tree as the server returned it. Create and edit run through the server; a category you create appears after the list is re-read."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'Catalogue' }]}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setModal({ open: true, mode: { kind: 'create' } })}
          >
            New category
          </Button>
        }
      />

      {cats.status === 'loading' && !cats.data && <ScreenLoading label="Loading categories" />}
      {cats.status === 'error' && <ScreenError error={cats.error} onRetry={cats.reload} />}

      {cats.data &&
        (tree.length === 0 ? (
          <ScreenEmpty
            title="No categories yet"
            description="The server returned an empty category tree."
            action={
              <Button variant="primary" onClick={() => setModal({ open: true, mode: { kind: 'create' } })}>
                Create the first category
              </Button>
            }
          />
        ) : (
          <section className="px-panel" aria-labelledby="cat-tree-h">
            <div className="px-panel__head">
              <h2 id="cat-tree-h">Category tree</h2>
              <span className="px-text-muted">Active categories only, as served</span>
            </div>
            {renderTree(tree, (c) => setModal({ open: true, mode: { kind: 'edit', category: c } }))}
          </section>
        ))}

      <CategoryModal
        open={modal.open}
        mode={modal.mode}
        categories={tree}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onSaved={() => {
          // Only reload after the server accepted the write.
          cats.reload();
        }}
      />
    </div>
  );
}
