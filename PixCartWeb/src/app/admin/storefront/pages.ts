/*
 * Admin → Storefront → Pages: the information pages (about, terms, privacy, returns ...) written in simple formatting
 * with a live preview. Built-in pages show their default text until saved. Port of
 * frontend/src/app/admin/storefront/pages.tsx.
 */

import { ChangeDetectionStrategy, Component, inject, signal } from "@angular/core";
import { ExternalLink, Plus } from "lucide-angular";
import { api, ApiError, quietly } from "../../core/api";
import { date } from "../../core/format";
import { Markdown } from "../../shared/chrome/markdown";
import { Icon } from "../../shared/ui/icon";
import { PageLoader } from "../../shared/ui/page-loader";
import { Button, ErrorNote, Field, Pill, Textarea, TextField, Toast } from "../../shared/ui/ui";

type P = { slug: string; title: string; body: string; meta_description: string; is_published: boolean; saved: boolean; updated_at: string | null };
type Cur = P & { original: string | null };

const slugFilter = (v: string) => v.toLowerCase().replace(/[^a-z0-9-]/g, "-");

@Component({
  selector: "pc-pages-editor",
  imports: [Markdown, Icon, PageLoader, Button, ErrorNote, Field, Pill, Textarea, TextField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!pages()) {
      <pc-page-loader />
    } @else {
      <div class="grid gap-4 lg:grid-cols-[240px_1fr]">
        <aside class="self-start rounded-xl bg-white p-2">
          <ul class="flex flex-col">
            @for (p of pages()!; track p.slug) {
              <li>
                <button (click)="pick(p)" [class]="cur()?.original === p.slug ? 'w-full rounded-lg px-3 py-2 text-left bg-peacock-light font-semibold text-peacock' : 'w-full rounded-lg px-3 py-2 text-left hover:bg-mist'">
                  {{ p.title }}
                  <span class="block text-xs font-normal text-ink-faint">/pages/{{ p.slug }}{{ !p.saved ? ", default text" : !p.is_published ? ", hidden" : "" }}</span>
                </button>
              </li>
            }
          </ul>
          <button pcButton variant="ghost" size="sm" class="mt-1 w-full" (click)="newPage()"><svg [pcIcon]="Plus" class="h-4 w-4" /> New page</button>
        </aside>
        @if (cur(); as c) {
          <section class="flex flex-col gap-3 rounded-xl bg-white p-5">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-lg font-semibold">{{ c.original ? "Edit page" : "New page" }}</h2>
              @if (!c.saved && c.original) {<pc-pill tone="blue">Showing default text until you save</pc-pill>}
              @if (c.updated_at) {<span class="text-sm text-ink-faint">Saved {{ fmtDate(c.updated_at) }}</span>}
              @if (c.original) {<a [href]="'/pages/' + c.original" target="_blank" rel="noreferrer" class="ml-auto inline-flex items-center gap-1 text-sm font-semibold text-peacock">Open page <svg [pcIcon]="ExternalLink" class="h-4 w-4" /></a>}
            </div>
            <pc-error-note [message]="error()" />
            <div class="grid gap-3 sm:grid-cols-2">
              <pc-text-field label="Title" [value]="c.title" maxlength="160" (valueChange)="patch({ title: $event })" />
              <pc-text-field label="Address" [value]="c.slug" maxlength="80" [filter]="slugFilter" (valueChange)="patch({ slug: $event })" [hint]="'yourshop.in/pages/' + c.slug" />
              <pc-text-field class="sm:col-span-2" label="Search engine description" [value]="c.meta_description" maxlength="300" (valueChange)="patch({ meta_description: $event })" />
            </div>
            <div class="grid gap-3 lg:grid-cols-2">
              <pc-field label="Content">
                <textarea pcTextarea rows="20" [value]="c.body" (input)="patch({ body: $any($event.target).value })" class="font-mono text-sm"></textarea>
              </pc-field>
              <div>
                <p class="mb-1 font-medium">Preview</p>
                <div class="max-h-[520px] overflow-auto rounded-lg border border-line p-4"><h1 class="mb-3 font-display text-2xl font-bold">{{ c.title }}</h1><pc-markdown [source]="c.body" /></div>
              </div>
            </div>
            <p class="text-xs text-ink-faint">Formatting: ## Heading, ### Smaller heading, **bold**, *italic*, - list item, 1. numbered item, [link text](/pages/about), &gt; quote</p>
            <label class="flex items-center gap-2"><input type="checkbox" class="accent-peacock" [checked]="c.is_published" (change)="patch({ is_published: $any($event.target).checked })" /> Published</label>
            <div class="flex gap-2">
              <button pcButton (click)="save()" [loading]="busy()">Save page</button>
              @if (c.saved && c.original) {<button pcButton variant="ghost" (click)="remove()">Delete page</button>}
            </div>
          </section>
        }
      </div>
    }
  `,
})
export class PagesEditor {
  private readonly toast = inject(Toast);
  protected readonly ExternalLink = ExternalLink;
  protected readonly Plus = Plus;
  protected readonly fmtDate = date;
  protected readonly slugFilter = slugFilter;
  protected readonly pages = signal<P[] | null>(null);
  protected readonly cur = signal<Cur | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  constructor() {
    this.load().then((p) => { if (p[0]) this.cur.set({ ...p[0], original: p[0].slug }); }).catch(quietly);
  }

  private load(): Promise<P[]> {
    return api<P[]>("/api/admin/storefront/pages").then((p) => { this.pages.set(p); return p; });
  }

  protected pick(p: P): void {
    this.error.set(null);
    this.cur.set({ ...p, original: p.slug });
  }
  protected newPage(): void {
    this.cur.set({ slug: "new-page", title: "New page", body: "", meta_description: "", is_published: false, saved: false, updated_at: null, original: null });
  }
  protected patch(p: Partial<Cur>): void {
    this.cur.update((c) => (c ? { ...c, ...p } : c));
  }

  protected async save(): Promise<void> {
    const cur = this.cur();
    if (!cur) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const r = await api<{ slug: string }>(`/api/admin/storefront/pages/${cur.original ?? cur.slug}`, { method: "PUT", body: { slug: cur.slug, title: cur.title, body: cur.body, meta_description: cur.meta_description, is_published: cur.is_published } });
      this.toast.show("Page saved");
      const list = await this.load();
      const p = list.find((x) => x.slug === r.slug);
      if (p) this.cur.set({ ...p, original: p.slug });
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "Could not save");
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const cur = this.cur();
    if (!cur) return;
    if (!window.confirm("Delete this page? Built-in pages go back to their default text.")) return;
    await api(`/api/admin/storefront/pages/${cur.original}`, { method: "DELETE" });
    const list = await this.load();
    this.cur.set(list[0] ? { ...list[0], original: list[0].slug } : null);
  }
}
