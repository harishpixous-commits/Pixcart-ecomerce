/*
 * AI drafts a person reviews before anything is sent. Port of components/ai.tsx (AiBadge, AiDraftButton):
 *   <pc-ai-badge mode="live|sandbox" />
 *   <pc-ai-draft-button base="/api/seller/ai" task="review_reply" [subjectId]="id" label="Draft reply with AI" (draft)="use($event)" />
 */

import { ChangeDetectionStrategy, Component, booleanAttribute, input, output, signal } from "@angular/core";
import { Sparkles } from "lucide-angular";
import { api, ApiError } from "../../core/api";
import { Icon } from "../ui/icon";
import { Button, ErrorNote, Field, Input, Pill, Select } from "../ui/ui";

export type AiRun = {
  id: string; task: string; task_label: string; status: string; mode: "live" | "sandbox"; model: string;
  output: { text?: string; subject?: string; [k: string]: unknown }; final_text: string; error: string;
  input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number; latency_ms: number;
  cost_usd: number | null; created_at: string; by?: string;
};

@Component({
  selector: "pc-ai-badge",
  imports: [Pill],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `@if (mode() === "sandbox") {<pc-pill tone="blue">Sandbox</pc-pill>} @else {<pc-pill tone="green">AI draft</pc-pill>}`,
})
export class AiBadge {
  readonly mode = input.required<"live" | "sandbox">();
}

const TONES = [["friendly", "Friendly"], ["formal", "Formal"], ["apologetic", "Apologetic"]] as const;

/** Asks for an AI draft and hands it back for a person to edit. The draft never goes anywhere on its own. */
@Component({
  selector: "pc-ai-draft-button",
  imports: [Button, ErrorNote, Field, Input, Select, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: "contents" },
  template: `
    @if (!open()) {
      <button pcButton type="button" size="sm" variant="secondary" (click)="open.set(true)"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> {{ label() }}</button>
    } @else {
      <div class="flex w-full flex-col gap-2 rounded-lg border border-peacock/30 bg-peacock-light/40 p-3">
        <div class="flex flex-wrap items-end gap-2">
          <pc-field label="Tone" class="w-40">
            <select pcSelect [value]="tone()" (change)="tone.set($any($event.target).value)">
              @for (t of tones; track t[0]) {<option [value]="t[0]" [selected]="t[0] === tone()">{{ t[1] }}</option>}
            </select>
          </pc-field>
          @if (withIntent()) {
            <pc-field [label]="intentLabel()" class="min-w-[240px] flex-1"><input pcInput [value]="intent()" maxlength="300" (input)="intent.set($any($event.target).value)" /></pc-field>
          }
          <button pcButton type="button" (click)="go()" [loading]="busy()" [disabled]="requireIntent() && intent().trim().length < 5"><svg [pcIcon]="Sparkles" class="h-4 w-4" /> Write draft</button>
          <button pcButton type="button" variant="ghost" (click)="open.set(false)">Cancel</button>
        </div>
        <pc-error-note [message]="error()" />
        <p class="text-xs text-ink-faint">You review and edit the draft before anything is sent.</p>
      </div>
    }
  `,
})
export class AiDraftButton {
  readonly base = input.required<string>();
  readonly task = input.required<string>();
  readonly subjectId = input.required<string>();
  readonly withIntent = input(false, { transform: booleanAttribute });
  readonly intentLabel = input("What should it say? (optional)");
  readonly label = input("Draft with AI");
  readonly requireIntent = input(false, { transform: booleanAttribute });
  readonly draft = output<AiRun>();
  protected readonly Sparkles = Sparkles;
  protected readonly tones = TONES;
  protected readonly open = signal(false);
  protected readonly tone = signal("friendly");
  protected readonly intent = signal("");
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async go(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const run = await api<AiRun>(`${this.base()}/tasks/${this.task()}`, { method: "POST", body: { subject_id: this.subjectId(), tone: this.tone(), intent: this.intent() } });
      this.draft.emit(run);
      this.open.set(false);
    } catch (e) {
      this.error.set(e instanceof ApiError ? e.message : "The AI draft failed. Try again.");
    } finally {
      this.busy.set(false);
    }
  }
}
