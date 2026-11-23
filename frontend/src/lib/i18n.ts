"use client";

/*
 * Shows every page (shop, seller hub, delivery app, admin panel) in the language the visitor picked.
 *
 * The site is written in English. When another language is chosen, this watches the page and replaces each piece of
 * text (and placeholder, tooltip and screen-reader label) with its translation. Translations come from the server
 * (/api/i18n/translate): lines staff corrected, lines translated before, or new lines the AI translates once
 * (Admin → Languages and currencies). Known lines are kept in the browser, so pages switch instantly next time.
 *
 * Numbers, amounts, dates and codes are kept out of what is translated ("Qty 2 at ₹449" is translated as
 * "Qty {0} at {1}"), so one translation serves every order and price. Anything inside translate="no" is left alone
 * (names, addresses, order numbers, the language list). React keeps working: when it changes a text, the new English
 * text is translated again.
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "CODE", "PRE", "KBD", "SAMP", "TEMPLATE", "IFRAME", "OPTION_SKIP"]);
const ATTRS = ["placeholder", "title", "aria-label"] as const;
const LETTER = /\p{L}/u;
const NUMBERISH = /\S*\d\S*/g; // a word with a digit: an amount, date, time, quantity or code
const MAX_LEN = 400;
const BATCH = 80;

type Applied = { src: string; out: string };

function template(text: string): { key: string; values: string[] } {
  const values: string[] = [];
  const key = text.replace(NUMBERISH, (m) => `{${values.push(m) - 1}}`);
  return { key, values };
}

function fill(translated: string, values: string[]): string {
  return translated.replace(/\{(\d+)\}/g, (m, i) => (values[Number(i)] ?? m));
}

function skipped(el: Element | null): boolean {
  for (let e = el; e; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.getAttribute("translate") === "no" || e.classList.contains("notranslate") || e.hasAttribute("data-no-translate")) return true;
    if ((e as HTMLElement).isContentEditable) return true;
  }
  return false;
}

export class PageTranslator {
  private lang: string;
  private dict = new Map<string, string>();
  private asked = new Set<string>(); // sent to the server this visit (found or not)
  private queue = new Set<string>();
  private texts = new WeakMap<Text, Applied>();
  private attrs = new WeakMap<Element, Map<string, Applied>>();
  private observer: MutationObserver | null = null;
  private dirty = new Set<Node>();
  private frame = 0;
  private timer = 0;
  private storeKey: string;

  constructor(lang: string) {
    this.lang = lang;
    this.storeKey = `pc_tr_${lang}`;
    try {
      const saved = JSON.parse(localStorage.getItem(this.storeKey) || "{}") as Record<string, string>;
      for (const [k, v] of Object.entries(saved)) this.dict.set(k, v);
    } catch { /* storage blocked or full */ }
  }

  start() {
    this.walk(document.body);
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") this.dirty.add(r.target);
        else if (r.type === "attributes") this.dirty.add(r.target);
        else r.addedNodes.forEach((n) => this.dirty.add(n));
      }
      if (!this.frame) this.frame = requestAnimationFrame(() => this.flushDirty());
    });
    this.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  }

  stop() {
    this.observer?.disconnect();
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
  }

  private flushDirty() {
    this.frame = 0;
    const nodes = [...this.dirty];
    this.dirty.clear();
    for (const n of nodes) if (n.isConnected) this.walk(n);
  }

  private walk(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) {
      this.text(root as Text);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const el = root as Element;
    if (skipped(el)) return;
    this.elementAttrs(el);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        if (n.nodeType === Node.ELEMENT_NODE) {
          const e = n as Element;
          if (SKIP_TAGS.has(e.tagName) || e.getAttribute("translate") === "no" || e.classList.contains("notranslate") || e.hasAttribute("data-no-translate")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const els = el.querySelectorAll("[placeholder],[title],[aria-label]");
    els.forEach((e) => { if (!skipped(e)) this.elementAttrs(e); });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) this.text(n as Text);
    this.scheduleAsk();
  }

  /** The translation of one piece of text, or null (not known yet: queued for the server). */
  private lookup(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_LEN || !LETTER.test(trimmed)) return null;
    const { key, values } = template(trimmed);
    if (!LETTER.test(key)) return null;
    const tr = this.dict.get(key);
    if (tr === undefined) {
      if (!this.asked.has(key)) this.queue.add(key);
      return null;
    }
    const lead = raw.slice(0, raw.indexOf(trimmed));
    const tail = raw.slice(raw.indexOf(trimmed) + trimmed.length);
    return lead + fill(tr, values) + tail;
  }

  private text(node: Text) {
    const raw = node.nodeValue ?? "";
    const prev = this.texts.get(node);
    if (prev && raw === prev.out) return; // our own translation
    const out = this.lookup(raw);
    if (out !== null && out !== raw) {
      this.texts.set(node, { src: raw, out });
      node.nodeValue = out;
    }
  }

  private elementAttrs(el: Element) {
    for (const a of ATTRS) {
      const raw = el.getAttribute(a);
      if (!raw) continue;
      let m = this.attrs.get(el);
      const prev = m?.get(a);
      if (prev && raw === prev.out) continue;
      const out = this.lookup(raw);
      if (out !== null && out !== raw) {
        if (!m) this.attrs.set(el, (m = new Map()));
        m.set(a, { src: raw, out });
        el.setAttribute(a, out);
      }
    }
  }

  private scheduleAsk() {
    if (!this.queue.size || this.timer) return;
    this.timer = window.setTimeout(() => { this.timer = 0; void this.ask(); }, 120);
  }

  private async ask() {
    const batch = [...this.queue].slice(0, BATCH);
    batch.forEach((k) => { this.queue.delete(k); this.asked.add(k); });
    if (!batch.length) return;
    try {
      const res = await fetch("/api/i18n/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: this.lang, texts: batch }),
      });
      if (res.ok) {
        const data = (await res.json()) as { translations: Record<string, string> };
        let added = 0;
        for (const [k, v] of Object.entries(data.translations || {})) {
          this.dict.set(k, v);
          added += 1;
        }
        if (added) {
          this.persist();
          this.walk(document.body);
        }
      }
    } catch { /* offline: stays English */ }
    if (this.queue.size) this.scheduleAsk();
  }

  private persist() {
    try {
      const entries = [...this.dict.entries()].slice(-6000);
      localStorage.setItem(this.storeKey, JSON.stringify(Object.fromEntries(entries)));
    } catch { /* storage full */ }
  }
}
