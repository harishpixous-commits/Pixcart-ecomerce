/**
 * CMS management (FR-ADM-007).
 *
 * Data: `api.adminCms` → GET /api/v1/admin/cms → `{ items: CmsRow[] }`
 * (routes/admin.ts → repos/admin.ts listCms()). The list payload carries id,
 * kind, slug, title, locale, status, publishAt and updatedAt — it does NOT
 * carry the body or media/link URLs, so those are never displayed and are
 * never prefilled on edit (the body field on edit sends nothing unless the
 * operator types a new one, so an empty box cannot silently wipe content).
 *
 * Publishing is a state transition the SERVER decides: create with a
 * publish-at time becomes SCHEDULED, without it becomes DRAFT, and the
 * publish transition is server-side. This screen reflects the status the
 * server reports as a Badge and offers no client-side "publish" control.
 * PATCH (api.patchCms) mirrors the create body — the BFF in this
 * repository does not yet register a PATCH route, so an edit against it
 * surfaces the server's refusal verbatim.
 */
import { useState, type FormEvent } from 'react';
import { AlertTriangle, Pencil, Plus } from 'lucide-react';
import type { CmsRow } from '@contracts/dto';
import { Badge, Button, DataTable, Modal, SelectField, TextAreaField, TextField } from '../../design';
import type { Column } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { PageHeader, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import { useAsync } from '../lib/useAsync';
import { cmsStatusTone, humanise, toDateTimeLocal, toEpochMs, type ItemsResponse } from './common';
import './admin.css';

/** CmsRow.kind — contracts/dto.ts. */
const CMS_KINDS = ['PAGE', 'BANNER', 'BLOCK'] as const;

type FormMode = { kind: 'create' } | { kind: 'edit'; cms: CmsRow };

function CmsModal({
  open,
  mode,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: FormMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = mode.kind === 'edit' ? mode.cms : null;

  const [kind, setKind] = useState<string>('PAGE');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [locale, setLocale] = useState('en');
  const [publishAt, setPublishAt] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; traceId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seed the edit form from the real row each time the dialog opens.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (open && seededFor !== (editing?.id ?? '__create__')) {
    setSeededFor(editing?.id ?? '__create__');
    setKind(editing?.kind ?? 'PAGE');
    setSlug(editing?.slug ?? '');
    setTitle(editing?.title ?? '');
    setBody('');
    setLocale(editing?.locale ?? 'en');
    setPublishAt(editing?.publishAt ? toDateTimeLocal(Date.parse(editing.publishAt)) : '');
    setFieldErrors({});
    setFormError(null);
  }

  const submit = async () => {
    if (submitting) return;

    // Client pre-checks mirror the BFF's required fields (routes/admin.ts);
    // the server remains the authority and answers 422 with a field map.
    const errs: Record<string, string> = {};
    if (!slug.trim()) errs.slug = 'Slug is required';
    if (!title.trim()) errs.title = 'Title is required';

    let publishAtMs: number | null = null;
    if (publishAt.trim() !== '') {
      publishAtMs = toEpochMs(publishAt);
      if (publishAtMs === null) errs.publishAt = 'Enter a valid date and time';
    }

    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length > 0) return;

    const payload: Record<string, unknown> = {
      kind,
      slug: slug.trim(),
      title: title.trim(),
      locale: locale.trim() || 'en',
    };
    if (publishAtMs !== null) payload.publishAtMs = publishAtMs;
    if (mode.kind === 'create') {
      // The create contract accepts body/mediaUrl/linkUrl; only body is
      // offered here, and the server stores an empty string as null.
      payload.body = body;
    } else if (body.trim() !== '') {
      // Edit: send a new body only when the operator typed one — the list
      // endpoint never returned the stored body, so blank must mean "keep".
      payload.body = body;
    }

    setSubmitting(true);
    try {
      if (mode.kind === 'edit') await api.patchCms(mode.cms.id, payload);
      else await api.createCms(payload);
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
      title={editing ? `Edit content: ${editing.title}` : 'New content'}
      description={
        editing
          ? 'Sends the edited fields to the server. The stored status stays whatever the server last set; this form does not publish.'
          : 'The server stores the content as DRAFT, or as SCHEDULED when a publish time is given. Publishing is a separate server-side transition.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()}>
            {editing ? 'Save changes' : 'Create content'}
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

        <SelectField
          label="Kind"
          name="cms-kind"
          required
          value={kind}
          onValueChange={setKind}
          options={CMS_KINDS.map((k) => ({ value: k, label: humanise(k) }))}
        />
        <TextField
          label="Slug"
          name="cms-slug"
          required
          value={slug}
          onValueChange={setSlug}
          hint="Unique per locale on the server"
          serverError={fieldErrors.slug}
        />
        <TextField
          label="Title"
          name="cms-title"
          required
          value={title}
          onValueChange={setTitle}
          serverError={fieldErrors.title}
        />
        <TextAreaField
          label={mode.kind === 'edit' ? 'New body (optional)' : 'Body'}
          name="cms-body"
          rows={5}
          value={body}
          onValueChange={setBody}
          hint={
            mode.kind === 'edit'
              ? 'The list endpoint does not return the stored body — leave blank to keep it as-is'
              : 'May be empty; the server stores it as null when blank'
          }
          serverError={fieldErrors.body}
        />
        <TextField
          label="Locale"
          name="cms-locale"
          value={locale}
          onValueChange={setLocale}
          hint="BCP-47-ish tag, e.g. en or en-IN"
          serverError={fieldErrors.locale}
        />
        <TextField
          label="Publish at (optional)"
          name="cms-publish-at"
          type="datetime-local"
          value={publishAt}
          onValueChange={setPublishAt}
          hint="With a time the server stores the content as SCHEDULED; without one, as DRAFT"
          serverError={fieldErrors.publishAt}
        />
      </form>
    </Modal>
  );
}

export function AdminCmsScreen() {
  const cms = useAsync<ItemsResponse<CmsRow>>(
    async (signal) => (await api.adminCms(signal)) as ItemsResponse<CmsRow>,
    [],
  );
  const [modal, setModal] = useState<{ open: boolean; mode: FormMode }>({
    open: false,
    mode: { kind: 'create' },
  });

  const rows = cms.data?.items ?? [];

  const columns: Column<CmsRow>[] = [
    {
      key: 'title',
      header: 'Title',
      value: (r) => r.title,
      render: (r) => r.title,
    },
    {
      key: 'slug',
      header: 'Slug',
      secondary: true,
      value: (r) => r.slug,
      render: (r) => (
        <code className="px-num">
          /{r.slug} ({r.locale})
        </code>
      ),
    },
    {
      key: 'kind',
      header: 'Kind',
      value: (r) => r.kind,
      render: (r) => <Badge tone="info" size="sm">{humanise(r.kind)}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => <Badge tone={cmsStatusTone(r.status)}>{humanise(r.status)}</Badge>,
    },
    {
      key: 'publishAt',
      header: 'Publish at',
      secondary: true,
      value: (r) => r.publishAt ?? '',
      render: (r) => (r.publishAt ? <span className="px-num">{dateTime(r.publishAt)}</span> : <span className="px-text-muted">—</span>),
    },
    {
      key: 'updated',
      header: 'Updated',
      sortable: true,
      value: (r) => r.updatedAt,
      render: (r) => <span className="px-num">{dateTime(r.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Edit',
      render: (r) => (
        <Button
          size="sm"
          variant="secondary"
          icon={<Pencil size={14} aria-hidden="true" />}
          onClick={() => setModal({ open: true, mode: { kind: 'edit', cms: r } })}
        >
          Edit {r.title}
        </Button>
      ),
    },
  ];

  return (
    <div className="px-page">
      <PageHeader
        title="CMS"
        description="Pages, banners and blocks as the server returned them. The status badge reflects the server's own state — this console does not publish content itself."
        crumbs={[{ label: 'Admin', to: '/admin' }, { label: 'CMS' }]}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} aria-hidden="true" />}
            onClick={() => setModal({ open: true, mode: { kind: 'create' } })}
          >
            New content
          </Button>
        }
      />

      {cms.status === 'loading' && !cms.data && <ScreenLoading label="Loading CMS content" />}
      {cms.status === 'error' && <ScreenError error={cms.error} onRetry={cms.reload} />}

      {cms.data &&
        (rows.length === 0 ? (
          <ScreenEmpty
            title="No content yet"
            description="The server returned an empty CMS list."
            action={
              <Button variant="primary" onClick={() => setModal({ open: true, mode: { kind: 'create' } })}>
                Create the first content item
              </Button>
            }
          />
        ) : (
          <DataTable
            caption="CMS content"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            denseByDefault
          />
        ))}

      <CmsModal
        open={modal.open}
        mode={modal.mode}
        onClose={() => setModal((m) => ({ ...m, open: false }))}
        onSaved={() => cms.reload()}
      />
    </div>
  );
}
