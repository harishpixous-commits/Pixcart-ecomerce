/*
 * A small, safe Markdown renderer for CMS content: headings, paragraphs, bold, italic, links and lists. It builds a
 * tree of plain nodes rendered by the template (never raw HTML), so admin-entered text cannot inject scripts.
 * Port of components/markdown.tsx: <pc-markdown [source]="text" /> (class "prose-cms" unless mdClass is given).
 */

import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { PcLink } from "../ui/link";

type Inline = { t: "text"; v: string } | { t: "strong"; v: string } | { t: "em"; v: string } | { t: "link"; v: string; href: string; ext: boolean } | { t: "ilink"; v: string; href: string };
type Block = { t: "p"; c: Inline[] } | { t: "h1" | "h2" | "h3"; c: Inline[] } | { t: "ul" | "ol"; items: Inline[][] };

function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    const t = m[0];
    if (t.startsWith("**")) out.push({ t: "strong", v: t.slice(2, -2) });
    else if (t.startsWith("[")) {
      const label = t.slice(1, t.indexOf("]"));
      const href = t.slice(t.indexOf("(") + 1, -1);
      if (href.startsWith("/")) out.push({ t: "ilink", v: label, href });
      else if (href.startsWith("https://") || href.startsWith("mailto:") || href.startsWith("tel:")) out.push({ t: "link", v: label, href, ext: href.startsWith("https://") });
      else out.push({ t: "text", v: label });
    } else out.push({ t: "em", v: t.slice(1, -1) });
    last = m.index + t.length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ t: "p", c: inline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ t: list.ordered ? "ol" : "ul", items: list.items.map((it) => inline(it)) });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      blocks.push({ t: (["h1", "h2", "h3"] as const)[h[1].length - 1], c: inline(h[2]) });
    } else if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

@Component({
  selector: "pc-markdown",
  imports: [PcLink, NgTemplateOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "[class]": "mdClass() || 'prose-cms'", style: "display:block" },
  template: `
    <ng-template #inl let-c>@for (n of c; track $index) {@switch (n.t) {@case ("strong") {<strong>{{ n.v }}</strong>} @case ("em") {<em>{{ n.v }}</em>} @case ("ilink") {<a [pcLink]="n.href">{{ n.v }}</a>} @case ("link") {<a [href]="n.href" [attr.target]="n.ext ? '_blank' : null" rel="noopener noreferrer">{{ n.v }}</a>} @default {<ng-container>{{ n.v }}</ng-container>}}}</ng-template>
    @for (b of blocks(); track $index) {
      @switch (b.t) {
        @case ("h1") {<h1><ng-container *ngTemplateOutlet="inl; context: { $implicit: $any(b).c }" /></h1>}
        @case ("h2") {<h2><ng-container *ngTemplateOutlet="inl; context: { $implicit: $any(b).c }" /></h2>}
        @case ("h3") {<h3><ng-container *ngTemplateOutlet="inl; context: { $implicit: $any(b).c }" /></h3>}
        @case ("p") {<p><ng-container *ngTemplateOutlet="inl; context: { $implicit: $any(b).c }" /></p>}
        @case ("ul") {<ul>@for (it of $any(b).items; track $index) {<li><ng-container *ngTemplateOutlet="inl; context: { $implicit: it }" /></li>}</ul>}
        @case ("ol") {<ol>@for (it of $any(b).items; track $index) {<li><ng-container *ngTemplateOutlet="inl; context: { $implicit: it }" /></li>}</ol>}
      }
    }
  `,
})
export class Markdown {
  readonly source = input.required<string>();
  readonly mdClass = input<string>("");
  protected readonly blocks = computed(() => parseMarkdown(this.source()));
}
