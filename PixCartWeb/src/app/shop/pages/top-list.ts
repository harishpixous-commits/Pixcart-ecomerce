import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { api } from "../../core/api";
import { RouteState } from "../../core/route-state";
import type { CategoryNode, ProductCard } from "../../core/types";
import { ProductGrid, ProductRail } from "../../shared/product/product";

type CategoryRef = { name: string; slug: string };
export interface TopData {
  list: "bestsellers" | "new";
  category: CategoryRef | null;
  breadcrumbs?: CategoryRef[];
  children?: CategoryRef[];
  items?: ProductCard[];
  sections?: { category: CategoryRef; items: ProductCard[] }[];
  tree: CategoryNode[];
  new_release_days?: number;
}

@Component({
  selector: "pc-department-tree",
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    <ul [class]="depth() ? 'ml-3 border-l border-line pl-2' : ''">
      @for (node of visible(); track node.slug) {
        <li>
          <a [routerLink]="base()" [queryParams]="{category: node.slug}" [class]="'block rounded px-2 py-1 text-[14px] hover:bg-mist ' + (node.slug === current() ? 'font-semibold text-peacock' : 'text-ink-soft')">{{ node.name }}</a>
          @if (node.children.length > 0 && expanded(node)) {
            <pc-department-tree [nodes]="node.children" [current]="current()" [base]="base()" [depth]="depth() + 1" />
          }
        </li>
      }
    </ul>
  `,
})
export class DepartmentTree {
  readonly nodes = input.required<CategoryNode[]>();
  readonly current = input.required<string>();
  readonly base = input.required<string>();
  readonly depth = input(0);
  readonly visible = computed(() => this.nodes().filter(n => n.product_count > 0));
  expanded(node: CategoryNode) { return node.slug === this.current() || node.children.some(c => c.slug === this.current()); }
}

@Component({
  selector: "pc-top-list",
  imports: [RouterLink, DepartmentTree, ProductGrid, ProductRail],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "block" },
  template: `
    <div class="grid gap-4 lg:grid-cols-[230px_1fr]">
      <aside class="hidden self-start rounded-xl bg-white p-3 lg:sticky lg:top-40 lg:block" aria-label="Departments">
        <p class="px-2 pb-1 font-semibold">Any department</p>
        <a [routerLink]="base()" [class]="'block rounded px-2 py-1 text-[14px] hover:bg-mist ' + (!category() ? 'font-semibold text-peacock' : 'text-ink-soft')">All departments</a>
        @if (data(); as d) { <pc-department-tree [nodes]="d.tree" [current]="category()" [base]="base()" /> }
      </aside>
      <div class="flex min-w-0 flex-col gap-4">
        <header class="rounded-xl bg-white p-4 sm:p-5">
          @if (data()?.breadcrumbs; as crumbs) {
            <nav class="mb-1 text-sm text-ink-faint" aria-label="Breadcrumb">
              <a [routerLink]="base()" class="hover:text-peacock">{{ name() }}</a>
              @for (crumb of crumbs; track crumb.slug) { <span> › <a [routerLink]="base()" [queryParams]="{category: crumb.slug}" class="hover:text-peacock">{{ crumb.name }}</a></span> }
            </nav>
          }
          <h1 class="text-2xl font-semibold sm:text-3xl">{{ data()?.category ? name() + ' in ' + data()!.category!.name : name() }}</h1>
          <p class="text-ink-soft">{{ explain() }}</p>
          @if (data()?.children?.length) {
            <div class="scroll-x mt-3 flex gap-2 overflow-x-auto">
              @for (child of data()!.children!; track child.slug) { <a [routerLink]="base()" [queryParams]="{category: child.slug}" class="shrink-0 rounded-full border border-line px-3 py-1 text-sm hover:border-peacock hover:text-peacock">{{ child.name }}</a> }
            </div>
          }
          <div class="scroll-x mt-3 flex gap-2 overflow-x-auto lg:hidden">
            @for (node of mobileDepartments(); track node.slug) { <a [routerLink]="base()" [queryParams]="{category: node.slug}" [class]="'shrink-0 rounded-full px-3 py-1 text-sm ' + (node.slug === category() ? 'bg-peacock text-white' : 'bg-mist')">{{ node.name }}</a> }
          </div>
        </header>
        @if (error()) { <p class="rounded-xl bg-white p-6 text-vermilion">{{ error() }}</p> }
        @else if (!data()) {
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
            @for (slot of skeletons; track slot) { <div class="rounded-xl bg-white p-3"><div class="skeleton mb-3 aspect-square rounded-lg"></div><div class="skeleton h-4 rounded"></div></div> }
          </div>
        } @else if (data()!.category) {
          @if (data()!.items?.length) { <pc-product-grid [items]="data()!.items!" [ranked]="true" [showAdd]="true" /> }
          @else { <p class="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p> }
        } @else if (data()!.sections?.length) {
          @for (section of data()!.sections!; track section.category.slug) {
            <pc-product-rail [title]="name() + ' in ' + section.category.name" [items]="section.items" [ranked]="true" [href]="base() + '?category=' + section.category.slug" linkText="See more" />
          }
        } @else { <p class="rounded-xl bg-white p-6 text-ink-soft">Nothing here yet. Check back soon.</p> }
      </div>
    </div>
  `,
})
export class TopList {
  readonly list = input.required<"bestsellers" | "new">();
  private readonly route = inject(RouteState);
  readonly base = this.route.pathname;
  readonly category = computed(() => this.route.params().get("category") ?? "");
  readonly data = signal<TopData | null>(null);
  readonly error = signal("");
  readonly name = computed(() => this.list() === "bestsellers" ? "Bestsellers" : "Hot new releases");
  readonly explain = computed(() => this.list() === "bestsellers"
    ? "Our most popular products, by units sold in the last 30 days. Updated through the day."
    : `Products launched in the last ${this.data()?.new_release_days ?? 45} days, ranked by how fast they sell.`);
  readonly mobileDepartments = computed(() => this.data()?.tree.filter(n => n.product_count > 0) ?? []);
  readonly skeletons = Array.from({ length: 10 }, (_, i) => i);
  private request = 0;
  constructor() {
    effect(() => {
      const request = ++this.request;
      const query = { list: this.list(), category: this.category() || undefined };
      void api<TopData>("/api/catalog/top", { query }).then(
        data => { if (request === this.request) { this.error.set(""); this.data.set(data); } },
        error => { if (request === this.request) this.error.set(error.message || "Could not load the list"); },
      );
    });
  }
}
