/**
 * SCR-006 — Product detail (FR-CUS-002/003, FR-CUS-023/024).
 *
 * Four fetches, each with its own state: the listing, its published reviews and
 * histogram, and (signed-in only) the wishlist membership so the save button
 * tells the truth about where the listing already is. A failure of the reviews
 * rail never blanks the product — each surface degrades on its own.
 *
 * The schema has no description column and no image storage (both disclosed in
 * `services/bff/src/routes/storefront.ts`), so the description area shows the
 * attributes that do exist rather than invented copy, and the media pane falls
 * back to a labelled placeholder exactly as `ProductCard` does.
 *
 * Out of stock: "Notify me" saves the listing to the wishlist and says so. There
 * is no restock-alert job in this build (`notify_when_in_stock` defaults to 0
 * and nothing reads it), so promising a notification would be a lie.
 *
 * Buy now = add the line, then straight to /checkout — same `POST /cart/lines`
 * the cart button uses, so there is one add path, not two.
 */
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { ListingDetail, ListingSummary, Review, ReviewSummary } from '@contracts/dto';
import { Badge, Button, LinkButton, SelectField, TextAreaField, TextField, useToast } from '../../design';
import { ApiProblem, api } from '../../lib/api';
import { money, number, relativeTime } from '../../lib/format';
import { useAuth } from '../../app/AuthContext';
import { useAsync } from '../lib/useAsync';
import type { Crumb } from '../lib/Screen';
import { PageHeader, ProductGrid, ScreenEmpty, ScreenError, ScreenLoading } from '../lib/Screen';
import './customer.css';

/** `GET /listings/:id/reviews` returns the page plus the PUBLISHED-only summary. */
interface ReviewsPayload {
  items: Review[];
  nextCursor: string | null;
  summary: ReviewSummary;
}

interface WishlistPayload {
  items: ListingSummary[];
}

const RATING_OPTIONS = [
  { value: '5', label: '5 — Excellent' },
  { value: '4', label: '4 — Good' },
  { value: '3', label: '3 — Average' },
  { value: '2', label: '2 — Poor' },
  { value: '1', label: '1 — Terrible' },
];

/** Exact discount percentage, rounded only for display (CLAUDE.md §6). */
function offPct(mrp: number, price: number): number {
  return mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;
}

function Histogram({ summary }: { summary: ReviewSummary }) {
  const total = summary.count;
  return (
    <ul className="pxcu-hist" aria-label="Rating distribution">
      {(['5', '4', '3', '2', '1'] as const).map((star) => {
        const n = summary.histogram[star] ?? 0;
        const pct = total === 0 ? 0 : Math.round((n / total) * 100);
        return (
          <li key={star} className="pxcu-hist__row">
            <span>{star} ★</span>
            <span className="pxcu-hist__track">
              <span className="pxcu-hist__fill" style={{ width: `${pct}%` }} />
            </span>
            <span>{number(n)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function ProductScreen() {
  const { id = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { signedIn } = useAuth();

  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [wishing, setWishing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewRating, setReviewRating] = useState('5');
  const [reviewTitle, setReviewTitle] = useState('');
  const [reviewBody, setReviewBody] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const detail = useAsync<ListingDetail>(
    async (signal) => (await api.listing(id, signal)) as ListingDetail,
    [id],
  );
  const reviews = useAsync<ReviewsPayload>(
    async (signal) => (await api.reviews(id, signal)) as ReviewsPayload,
    [id],
  );
  // Guests never call the wishlist: a 401 would be noise, not information.
  const wish = useAsync<WishlistPayload | null>(
    async (signal) => (signedIn ? ((await api.wishlist(signal)) as WishlistPayload) : null),
    [signedIn],
  );

  if (detail.status === 'loading') {
    return (
      <div>
        <PageHeader title="Product" />
        <ScreenLoading label="Loading the product" />
      </div>
    );
  }
  if (detail.status === 'error' || !detail.data) {
    return (
      <div>
        <PageHeader title="Product" />
        <ScreenError error={detail.error} onRetry={detail.reload} />
      </div>
    );
  }

  const d = detail.data;
  const off = offPct(d.mrpPaise, d.pricePaise);
  const onWishlist = wish.data?.items.some((x) => x.id === d.id) ?? false;
  const summary = reviews.data?.summary;
  const maxQty = 10; // BFF cart domain cap (cart-domain max per line).

  const crumbs: Crumb[] = [
    { label: 'Home', to: '/' },
    { label: d.categorySlug, to: `/category/${d.categorySlug}` },
    { label: d.title },
  ];

  async function addToCart(goCheckout: boolean): Promise<void> {
    if (adding) return;
    setAdding(true);
    try {
      await api.addLine({ listingId: id, qty });
      toast.success(`Added ${qty === 1 ? 'one item' : `${qty} items`} to your cart`);
      if (goCheckout) navigate('/checkout');
    } catch (err) {
      if (err instanceof ApiProblem) toast.error(err.problem.detail || err.problem.title);
      else toast.error('Could not reach the server. Check your connection and try again.');
    } finally {
      setAdding(false);
    }
  }

  async function toggleWishlist(): Promise<void> {
    if (!signedIn) {
      navigate('/login', { state: { from: location.pathname } });
      return;
    }
    if (wishing) return;
    setWishing(true);
    try {
      if (onWishlist) {
        await api.removeWishlist(d.id);
        setWishing(false);
        wish.setData((cur) =>
          cur ? { items: cur.items.filter((x) => x.id !== d.id) } : cur,
        );
        toast.success('Removed from your wishlist');
      } else {
        await api.addWishlist(d.id);
        setWishing(false);
        wish.setData((cur) =>
          cur ? { items: [...cur.items, d] } : { items: [d] },
        );
        toast.success('Saved to your wishlist');
      }
    } catch (err) {
      setWishing(false);
      if (err instanceof ApiProblem) toast.error(err.problem.detail || err.problem.title);
      else toast.error('Could not reach the server. Check your connection and try again.');
    }
  }

  async function submitReview(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (reviewSubmitting) return;
    setReviewSubmitting(true);
    setReviewError(null);
    try {
      await api.postReview(id, {
        rating: Number(reviewRating),
        title: reviewTitle.trim(),
        body: reviewBody.trim(),
      });
      setReviewSubmitting(false);
      setReviewOpen(false);
      setReviewTitle('');
      setReviewBody('');
      reviews.reload();
      toast.success('Review submitted. It appears once a moderator publishes it.');
    } catch (err) {
      setReviewSubmitting(false);
      if (err instanceof ApiProblem) {
        if (err.status === 409) setReviewError(err.problem.detail || 'You have already reviewed this listing.');
        else if (err.status === 422 && err.fields) setReviewError(Object.values(err.fields).join(' · '));
        else setReviewError(err.problem.detail || err.problem.title);
      } else {
        setReviewError('Could not reach the server. Check your connection and try again.');
      }
    }
  }

  return (
    <div>
      <PageHeader title={d.title} crumbs={crumbs} />

      <div className="px-split">
        <div>
          <div className="pxcu-media">
            {d.images.length > 0 ? (
              <img src={d.images[0]} alt={d.title} />
            ) : (
              // No image pipeline in V001-V007 (disclosed in the BFF): a
              // labelled placeholder, never a broken <img>.
              <span className="pxcu-media__ph" aria-hidden="true">
                {d.title.slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>

          <section className="px-panel" aria-labelledby="pdp-attrs" style={{ marginTop: 'var(--px-space-5)' }}>
            <div className="px-panel__head">
              <h2 id="pdp-attrs">Details</h2>
            </div>
            {d.description === '' ? (
              // The schema has no description column; say so rather than
              // inventing marketing copy.
              <p className="pxcu-muted">
                This catalogue has no product description yet — the structured attributes below
                are everything the seller recorded.
              </p>
            ) : (
              <p>{d.description}</p>
            )}
            <dl className="px-dl" style={{ marginTop: 'var(--px-space-4)' }}>
              <dt>Brand</dt>
              <dd>{d.brand ?? '—'}</dd>
              <dt>Vendor</dt>
              <dd>{d.vendorName}</dd>
              <dt>Category</dt>
              <dd>
                <Link to={`/category/${d.categorySlug}`}>{d.categorySlug}</Link>
              </dd>
              <dt>HSN code</dt>
              <dd className="px-num">{d.hsnCode}</dd>
              {Object.entries(d.attributes).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>

            {d.variants.length > 0 && (
              <section aria-labelledby="pdp-variants" style={{ marginTop: 'var(--px-space-5)' }}>
                <h3 id="pdp-variants">Variants</h3>
                <ul className="pxcu-cats">
                  {d.variants.map((v) => (
                    <li key={v.id}>
                      <span className="pxcu-cat">
                        {Object.entries(v.optionMap)
                          .map(([k, val]) => `${k}: ${val}`)
                          .join(' · ') || v.sku}
                        {!v.inStock && <span className="pxcu-cat__count">out of stock</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </section>

          <section className="px-panel" aria-labelledby="pdp-reviews" style={{ marginTop: 'var(--px-space-5)' }}>
            <div className="px-panel__head">
              <h2 id="pdp-reviews">Reviews</h2>
              {signedIn && !reviewOpen && (
                <Button variant="secondary" size="sm" onClick={() => setReviewOpen(true)}>
                  Write a review
                </Button>
              )}
            </div>

            {summary && summary.count > 0 && (
              <div className="pxcu-row" style={{ alignItems: 'flex-start', marginBottom: 'var(--px-space-4)' }}>
                <p className="pxcu-price__now" aria-hidden="true">
                  ★ {summary.average.toFixed(1)}
                </p>
                <p className="pxcu-muted">
                  {number(summary.count)} {summary.count === 1 ? 'review' : 'reviews'}
                </p>
                <Histogram summary={summary} />
              </div>
            )}

            {reviewOpen && (
              <form className="px-form" onSubmit={submitReview} noValidate style={{ marginBottom: 'var(--px-space-5)' }}>
                {reviewError && (
                  <div className="px-screenstate px-screenstate--error" role="alert">
                    <p className="px-screenstate__msg">{reviewError}</p>
                  </div>
                )}
                <SelectField
                  label="Your rating"
                  name="rating"
                  value={reviewRating}
                  options={RATING_OPTIONS}
                  onValueChange={setReviewRating}
                  required
                />
                <TextField
                  label="Headline"
                  name="reviewTitle"
                  value={reviewTitle}
                  onValueChange={setReviewTitle}
                  maxLength={120}
                />
                <TextAreaField
                  label="Your review"
                  name="reviewBody"
                  value={reviewBody}
                  onValueChange={setReviewBody}
                  rows={4}
                  maxLength={2000}
                  hint="Reviews are published after moderation. Your name is shown; your contact details never are."
                />
                <div className="px-form__actions">
                  <Button type="submit" variant="primary" loading={reviewSubmitting}>
                    Submit review
                  </Button>
                  <Button variant="ghost" onClick={() => setReviewOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}

            {reviews.status === 'loading' && <ScreenLoading label="Loading reviews" />}
            {reviews.status === 'error' && (
              <ScreenError error={reviews.error} onRetry={reviews.reload} />
            )}
            {reviews.status === 'success' &&
              (reviews.data && reviews.data.items.length > 0 ? (
                <ul className="pxcu-reviews">
                  {reviews.data.items.map((r) => (
                    <li key={r.id} className="pxcu-review">
                      <div className="pxcu-review__head">
                        <span className="pxcu-review__author">{r.customerName}</span>
                        <span className="px-num" aria-label={`Rated ${r.rating} of 5`}>
                          ★ {r.rating}
                        </span>
                        {r.verifiedPurchase && <Badge tone="success" size="sm">Verified purchase</Badge>}
                        <span className="pxcu-review__meta">{relativeTime(r.createdAt)}</span>
                      </div>
                      {r.title && <h3 className="pxcu-review__head">{r.title}</h3>}
                      {r.body && <p className="pxcu-review__body">{r.body}</p>}
                    </li>
                  ))}
                </ul>
              ) : (
                !reviewOpen && (
                  <ScreenEmpty
                    title="No reviews yet"
                    description={
                      signedIn
                        ? 'Be the first to review this listing.'
                        : 'Sign in after your order is delivered to write the first review.'
                    }
                    action={
                      signedIn ? undefined : <LinkButton to="/login">Sign in</LinkButton>
                    }
                  />
                )
              ))}
          </section>
        </div>

        <div className="pxcu-buybox">
          <div className="pxcu-price">
            <span className="pxcu-price__now px-num">{money(d.pricePaise)}</span>
            {d.mrpPaise > d.pricePaise && (
              <>
                <span className="pxcu-price__mrp px-num">{money(d.mrpPaise)}</span>
                <span className="pxcu-price__off">{off}% off</span>
              </>
            )}
          </div>

          <p className="pxcu-muted">
            {d.inStock ? (
              <Badge tone="success" size="sm">In stock</Badge>
            ) : (
              <Badge tone="danger" size="sm">Out of stock</Badge>
            )}{' '}
            Sold by <strong>{d.vendorName}</strong>
            {typeof d.ratingAvg === 'number' && d.ratingAvg > 0 && (
              <>
                {' · '}
                <span className="px-num">★ {d.ratingAvg.toFixed(1)}</span> (
                {number(d.ratingCount)})
              </>
            )}
          </p>

          <div className="pxcu-qty">
            <span id="pdp-qty-label">Quantity</span>
            <Button
              aria-label="Decrease quantity"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              disabled={qty <= 1}
            >
              −
            </Button>
            <span className="pxcu-qty__value px-num" aria-live="polite">
              {qty}
            </span>
            <Button
              aria-label="Increase quantity"
              onClick={() => setQty((q) => Math.min(maxQty, q + 1))}
              disabled={qty >= maxQty}
            >
              +
            </Button>
          </div>

          {d.inStock ? (
            <>
              <Button variant="primary" block loading={adding} onClick={() => addToCart(false)}>
                Add to cart
              </Button>
              <Button variant="secondary" block loading={adding} onClick={() => addToCart(true)}>
                Buy now
              </Button>
            </>
          ) : (
            <p className="pxcu-note">
              Out of stock. “Save to wishlist” keeps it on your list — this build has no
              restock-alert job, so nothing will notify you when it returns.
            </p>
          )}

          <Button variant="ghost" block loading={wishing} onClick={toggleWishlist}>
            {onWishlist ? 'Remove from wishlist' : d.inStock ? 'Save to wishlist' : 'Notify me (saves to wishlist)'}
          </Button>

          {!signedIn && (
            <p className="pxcu-muted">
              Saving and buying need an account. <Link to="/login">Sign in</Link>
            </p>
          )}
        </div>
      </div>

      {d.similar.length > 0 && (
        <section className="px-rail" aria-labelledby="pdp-similar" style={{ marginTop: 'var(--px-space-8)' }}>
          <div className="px-rail__head">
            <h2 id="pdp-similar">Similar products</h2>
          </div>
          <ProductGrid items={d.similar} />
        </section>
      )}
    </div>
  );
}
