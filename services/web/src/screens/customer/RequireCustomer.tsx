/**
 * Client-side gate for personal surfaces (cart, checkout, orders, returns,
 * wishlist).
 *
 * App.tsx wraps `/account/*` in `RequireRole` but leaves the commerce routes
 * open, so these screens must handle the signed-out case themselves. Redirecting
 * before the request avoids a 401 round trip and an error flash; the BFF would
 * refuse with `UNAUTHENTICATED` anyway (`customer(ctx)` in every commerce
 * route). `LoginScreen` reads `state.from`, so the visitor lands back on the
 * page they asked for. The redirect decision is presentation only — every write
 * is still refused server-side if the token is missing or dead.
 */
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../app/AuthContext';
import { ScreenLoading } from '../lib/Screen';

export function RequireCustomer({ children }: { children: ReactNode }) {
  const { signedIn, loading } = useAuth();
  const location = useLocation();

  if (loading) return <ScreenLoading label="Checking your session" />;
  if (!signedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
