/**
 * Status → badge tone, shared by the order and return screens.
 *
 * §8.4: status is never colour-only — `Badge` already pairs every tone with its
 * own glyph, so this mapping only chooses the tone; the meaning stays in the
 * text the screen prints next to it. Unknown states fall back to `neutral`
 * rather than being coloured optimistically: a state the vocabulary does not
 * know must not look like success.
 */
import type { BadgeTone } from '../../design';

export function orderTone(status: string): BadgeTone {
  switch (status) {
    case 'DELIVERED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    case 'CONFIRMED':
    case 'ACCEPTED':
      return 'info';
    case 'PACKED':
    case 'SHIPPED':
    case 'OUT_FOR_DELIVERY':
      return 'progress';
    case 'NDR':
    case 'RTO_INITIATED':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function rmaTone(state: string): BadgeTone {
  switch (state) {
    case 'REQUESTED':
    case 'APPROVED':
    case 'PICKUP_SCHEDULED':
    case 'PICKED_UP':
    case 'IN_TRANSIT':
    case 'QC_PASSED':
    case 'REFUND_INITIATED':
      return 'progress';
    case 'REFUNDED':
      return 'success';
    case 'REJECTED':
    case 'QC_FAILED':
      return 'danger';
    case 'CLOSED':
      return 'neutral';
    default:
      return 'neutral';
  }
}
