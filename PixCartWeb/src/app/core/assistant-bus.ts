
/** Opens the admin AI assistant from anywhere (export cards, list pages) with an optional prompt and page context. */
export type AssistantOpen = { prompt?: string; send?: boolean; context?: { path?: string; title?: string; filters?: string }; attach?: boolean };

export function openAssistant(detail: AssistantOpen = {}) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<AssistantOpen>("assistant:open", { detail }));
}
