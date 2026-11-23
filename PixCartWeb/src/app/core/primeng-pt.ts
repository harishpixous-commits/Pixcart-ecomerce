/*
 * PrimeNG runs unstyled (no PrimeNG theme CSS). This pass-through preset gives PrimeNG's parts the reference site's
 * classes (styles/_site.scss), so a PrimeNG control looks like the reference control it replaces. Components can add
 * or override classes per use with [pt] or styleClass. Keep these in step with components/ui.tsx in the reference.
 */

import type { GlobalPassThrough } from "primeng/config";

const FIELD =
  "h-10 w-full rounded-lg border border-line bg-white px-3 text-[15px] text-ink placeholder:text-ink-faint focus:border-peacock focus:outline-none focus:ring-2 focus:ring-peacock/20 disabled:bg-mist";
const OVERLAY = "z-50 mt-1 overflow-hidden rounded-lg bg-white py-1 text-ink shadow-xl ring-1 ring-line";
const OPTION = "flex cursor-pointer items-center gap-2 px-3 py-2 text-[15px] hover:bg-mist aria-selected:bg-peacock-light aria-selected:text-peacock";

export const PIXCART_PT: GlobalPassThrough = {
  // ui.ts <pc-modal>: the mask and panel of the reference Modal
  dialog: {
    mask: { class: "fixed inset-0 z-50 flex items-end justify-center bg-ink/50 p-0 sm:items-center sm:p-4" },
  },
  // side drawers
  drawer: {
    mask: { class: "fixed inset-0 z-[60] flex bg-ink/60" },
    root: { class: "relative flex h-full w-[86%] max-w-[365px] flex-col overflow-y-auto bg-white shadow-2xl" },
  },
  select: {
    root: { class: `${FIELD} relative flex items-center pr-8` },
    label: { class: "min-w-0 flex-1 truncate" },
    dropdown: { class: "absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint" },
    overlay: { class: OVERLAY },
    option: { class: OPTION },
  },
  inputText: { root: { class: FIELD } },
  textarea: { root: { class: `${FIELD} h-auto min-h-[96px] py-2` } },
  checkbox: { root: { class: "relative inline-flex h-4 w-4" }, input: { class: "peer absolute inset-0 h-4 w-4 cursor-pointer opacity-0" } },
  datePicker: { panel: { class: `${OVERLAY} p-3` } },
  tooltip: { root: { class: "pointer-events-none absolute z-[90] max-w-xs rounded-md bg-ink px-2 py-1 text-xs text-white shadow" } },
  dataTable: {
    table: { class: "w-full min-w-[640px] text-left text-[15px]" },
    thead: { class: "border-b border-line text-sm text-ink-faint" },
    tbody: { class: "divide-y divide-line" },
  },
};
