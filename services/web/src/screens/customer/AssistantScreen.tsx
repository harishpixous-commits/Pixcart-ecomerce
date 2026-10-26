/**
 * SCR-017 — Shopping assistant (FR-AI-*).
 *
 * The BFF answers from a deterministic rules engine, not a language model:
 * `POST /assistant/ask` returns `{ mode: 'rules', answer, source, citations }`
 * and says so on every response. This screen renders each answer as a canned
 * rule explanation labelled with its source, and carries a standing notice
 * that no model is bound — presenting rule text as a model's free-form reply
 * would misrepresent what the system did.
 *
 * Messages live in component state, not the URL: a transcript is personal and
 * ephemeral, and putting it in the address bar would leak questions into
 * history, referrers and screenshots. The fetch itself still goes through
 * `useAsync`, so it gets the same abort-on-navigate and error machinery as
 * every other screen.
 */
import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { Send } from 'lucide-react';
import { Button, TextField } from '../../design';
import { api, type RuleAnswer } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useAsync } from '../lib/useAsync';
import { PageHeader, ScreenError, ScreenLoading } from '../lib/Screen';
import './customer.css';

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  source?: string;
  citations?: string[];
}

/** Starter prompts the rules engine actually answers — not decorative chips. */
const SUGGESTIONS = [
  'Is cash on delivery available?',
  'How do returns work?',
  'How are coupons applied?',
  'How do I track my delivery?',
  'How does the wallet work?',
];

export function AssistantScreen() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [nextId, setNextId] = useState(1);

  // The pending question drives one useAsync fetch; nonce keeps repeats distinct.
  const [pending, setPending] = useState<{ id: number; q: string } | null>(null);
  const answer = useAsync<RuleAnswer | null>(
    async (signal) => (pending ? api.assistantSuggestions(pending.q, signal) : null),
    [pending?.id],
  );

  // Append the assistant reply once it settles, then clear the pending slot.
  useEffect(() => {
    if (!pending) return;
    if (answer.status === 'success' && answer.data) {
      setTurns((t) => [
        ...t,
        {
          id: pending.id + 1,
          role: 'assistant',
          text: answer.data!.answer,
          at: new Date().toISOString(),
          source: answer.data!.source,
          citations: answer.data!.citations,
        },
      ]);
      setPending(null);
    }
  }, [answer.status, answer.data, pending]);

  function ask(question: string): void {
    const q = question.trim();
    if (!q || pending) return;
    const id = nextId;
    setNextId(id + 2);
    setTurns((t) => [...t, { id, role: 'user', text: q, at: new Date().toISOString() }]);
    setPending({ id, q });
    setDraft('');
  }

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    ask(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    // Enter sends; Shift+Enter is not offered because this is a single-line
    // field — a multi-line composer would need a textarea, which the design
    // system's TextAreaField covers when the transcript grows that far.
    if (e.key === 'Enter') {
      e.preventDefault();
      ask(draft);
    }
  }

  return (
    <div>
      <PageHeader
        title="Shopping assistant"
        description="Answers about delivery, returns, coupons, the wallet, loyalty and cash on delivery."
      />

      <p className="pxcu-note">
        This assistant runs in <strong>rules mode</strong>. There is no language model bound in
        this build (docs/LIMITATIONS.md §0); every answer is looked up from the platform's own
        rule sources and labelled with them. Nothing here is generated text.
      </p>

      <div className="px-chat">
        {turns.length === 0 && (
          <>
            <p className="pxcu-muted">Ask about one of these, or type your own question:</p>
            <ul className="pxcu-chips__list" aria-label="Suggested questions">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" className="px-chip px-chip--button" onClick={() => ask(s)}>
                    <span className="px-chip__text">{s}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <ul className="px-chat__list" aria-live="polite" aria-label="Conversation">
          {turns.map((t) => (
            <li
              key={t.id}
              className={`px-chat__bubble ${t.role === 'user' ? 'px-chat__bubble--user' : ''}`}
            >
              <span className="px-chat__meta">
                {t.role === 'user' ? 'You' : `Rules · ${t.source ?? 'engine'}`} · {dateTime(t.at)}
              </span>
              {t.text}
              {t.citations && t.citations.length > 0 && (
                <span className="px-chat__meta">Source: {t.citations.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>

        {answer.status === 'loading' && <ScreenLoading label="Looking that up" />}
        {answer.status === 'error' && (
          <ScreenError
            error={answer.error}
            onRetry={() => pending && setPending({ ...pending, q: pending.q })}
          />
        )}

        <form className="px-chat__composer" onSubmit={onSubmit}>
          <TextField
            label="Ask the assistant"
            hideLabel
            name="question"
            placeholder="Ask about delivery, returns, coupons, wallet or COD…"
            value={draft}
            onValueChange={setDraft}
            onKeyDown={onKeyDown}
            autoComplete="off"
          />
          <Button type="submit" variant="primary" loading={answer.status === 'loading'}>
            <Send size={16} aria-hidden="true" /> Ask
          </Button>
        </form>

        <p className="pxcu-muted">
          Want a human? <Link to="/orders">Your orders</Link> and the{' '}
          <Link to="/returns">returns desk</Link> are always available.
        </p>
      </div>
    </div>
  );
}
