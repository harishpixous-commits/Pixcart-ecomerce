/**
 * Assistant route (FR-AI-*): rules-only answers, no LLM.
 *
 * The AI orchestrator and provider adapters are unbuilt (docs/LIMITATIONS.md
 * §0: no LLM key, no FastAPI host). Rather than fake a model response, this
 * route answers from the same deterministic rule sources the rest of the BFF
 * uses — the promotions engine's rejection reasons, the quote engine's COD
 * gate, and the query-understanding policy list. `mode: 'rules'` tells the
 * client this is not a generative answer, so it can render it as a canned
 * explanation instead of streaming text.
 *
 * When a real orchestrator lands behind this route, the response `mode`
 * becomes 'llm' and the answer is the model's; nothing else changes.
 */
import { Router, badRequest } from '../http.js';
import type { Ctx } from '../db.js';
import { body, str } from './validate.js';
import { BANNED_TERMS, POLICY_MESSAGE } from '../repos/query-understanding.js';
import { COD_MAX_PAISE } from '../repos/quote.js';

interface RuleAnswer {
  mode: 'rules';
  answer: string;
  source: string;
  citations: string[];
}

/** Register assistant routes onto `router`. */
export function register(router: Router): void {
  /** Deterministic, keyword-routed rule answers. No network, no model. */
  router.post('/api/v1/assistant/ask', async (ctx: Ctx): Promise<RuleAnswer> => {
  const b = body<{ question?: unknown }>(ctx);
  const q = str(b.question);
  if (!q) throw badRequest('question is required', 'QUESTION_REQUIRED');
  const lower = q.toLowerCase();

  if (BANNED_TERMS.some((t) => lower.includes(t))) {
    return { mode: 'rules', answer: POLICY_MESSAGE, source: 'prohibited-items-policy', citations: ['FR-CUS-009'] };
  }
  if (/(cod|cash on delivery)/.test(lower)) {
    return {
      mode: 'rules',
      answer: `Cash on delivery is available for orders up to Rs.${(COD_MAX_PAISE / 100).toLocaleString('en-IN')} (Rs.10,000) to a serviceable PIN with a fraud score below the threshold. Above that, prepaid is required.`,
      source: 'BRU-05',
      citations: ['BRU-05', 'FR-CUS-014'],
    };
  }
  if (/(return|refund)/.test(lower)) {
    return {
      mode: 'rules',
      answer: 'Returns are raised from the order detail screen while the sub-order is DELIVERED. Damaged or wrong-item returns need photo evidence. Refunds return to the original payment method or your wallet.',
      source: 'FR-CUS-017/018',
      citations: ['FR-CUS-017', 'FR-CUS-018'],
    };
  }
  if (/(coupon|discount|offer)/.test(lower)) {
    return {
      mode: 'rules',
      answer: 'One platform coupon applies per order; vendor coupons stack only when the platform coupon allows it. The discount waterfall is deterministic: sale price, then quantity deals, then vendor coupon, then platform coupon, then loyalty, then wallet promo.',
      source: 'FR-MKT-010 / BRU-14',
      citations: ['FR-MKT-010', 'BRU-14'],
    };
  }
  if (/(shipping|delivery|track)/.test(lower)) {
    return {
      mode: 'rules',
      answer: 'Each vendor ships as its own sub-order; tracking appears on the order detail once the vendor marks it shipped. Delivery estimates come from the vendor SLA clock at placement.',
      source: 'FR-CUS-016',
      citations: ['FR-CUS-016', 'BRU-03'],
    };
  }
  if (/(wallet|loyalty|points)/.test(lower)) {
    return {
      mode: 'rules',
      answer: 'Wallet credit is bucketed into cash (never expires) and promo (90-day expiry), consumed earliest-expiry first. Loyalty points are 1 point = Rs.1 at checkout, capped by what is left to pay.',
      source: 'FR-CUS-019/020',
      citations: ['FR-CUS-019', 'FR-CUS-020'],
    };
  }
  return {
    mode: 'rules',
    answer: 'I can explain delivery, returns, coupons, the wallet, loyalty, and cash-on-delivery rules. Ask about one of those.',
    source: 'fallback',
    citations: [],
  };
  });
}
