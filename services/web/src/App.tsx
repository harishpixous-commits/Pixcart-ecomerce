/**
 * Route table for the R1 release.
 *
 * Every path here is one of the 29 screens selected for R1 (Vol. 8 §8.5). Roles gate
 * the operator surfaces: the vendor and admin trees render behind a `RequireRole`
 * boundary that sends an unauthenticated visitor to /login and a signed-in visitor
 * without the role to a 403 page that names the role required. Hiding the links is
 * not the control — the route itself is.
 */
import { Routes, Route, Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppShell } from './app/AppShell';
import { useAuth } from './app/AuthContext';
import type { Role } from '@contracts/dto';

import { HomeScreen } from './screens/customer/HomeScreen';
import { CategoryScreen } from './screens/customer/CategoryScreen';
import { SearchScreen } from './screens/customer/SearchScreen';
import { ProductScreen } from './screens/customer/ProductScreen';
import { CartScreen } from './screens/customer/CartScreen';
import { CheckoutScreen } from './screens/customer/CheckoutScreen';
import { OrderConfirmedScreen } from './screens/customer/OrderConfirmedScreen';
import { OrdersScreen } from './screens/customer/OrdersScreen';
import { OrderDetailScreen } from './screens/customer/OrderDetailScreen';
import { ReturnsScreen } from './screens/customer/ReturnsScreen';
import { WishlistScreen } from './screens/customer/WishlistScreen';
import { AssistantScreen } from './screens/customer/AssistantScreen';
import { LoginScreen } from './screens/customer/LoginScreen';
import { RegisterScreen } from './screens/customer/RegisterScreen';
import { AccountScreen } from './screens/customer/AccountScreen';
import { AddressesScreen } from './screens/customer/AddressesScreen';
import { NotificationsScreen } from './screens/customer/NotificationsScreen';
import { WalletScreen } from './screens/customer/WalletScreen';

import { VendorDashboardScreen } from './screens/vendor/VendorDashboardScreen';
import { VendorProductsScreen } from './screens/vendor/VendorProductsScreen';
import { VendorInventoryScreen } from './screens/vendor/VendorInventoryScreen';
import { VendorOrdersScreen } from './screens/vendor/VendorOrdersScreen';
import { VendorFinanceScreen } from './screens/vendor/VendorFinanceScreen';
import { VendorOnboardingScreen } from './screens/vendor/VendorOnboardingScreen';

import { AdminOverviewScreen } from './screens/admin/AdminOverviewScreen';
import { AdminApprovalsScreen } from './screens/admin/AdminApprovalsScreen';
import { AdminCatalogueScreen } from './screens/admin/AdminCatalogueScreen';
import { AdminOrdersScreen } from './screens/admin/AdminOrdersScreen';
import { AdminMarketingScreen } from './screens/admin/AdminMarketingScreen';
import { AdminFinanceScreen } from './screens/admin/AdminFinanceScreen';
import { AdminUsersScreen } from './screens/admin/AdminUsersScreen';
import { AdminCmsScreen } from './screens/admin/AdminCmsScreen';
import { AdminAuditScreen } from './screens/admin/AdminAuditScreen';
import { AdminNotificationsScreen } from './screens/admin/AdminNotificationsScreen';

/**
 * Route guard.
 *
 * This is presentation only — it decides where to send a visitor, never whether an
 * action is permitted. Every write the UI exposes is still checked server-side by the
 * BFF via identity-svc's capability matrix, so bypassing this component gets a 403,
 * not access.
 */
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="px-page" aria-busy="true">
        <p className="px-text-muted">Checking your session…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) {
    return (
      <div className="px-page">
        <h1>You do not have access to this area</h1>
        <p>
          This area is for the {roles.join(' or ')} role. You are signed in as{' '}
          <strong>{user.role}</strong>.
        </p>
        <p>
          If you believe this is wrong, the permission is held in the identity service — ask an
          administrator to grant it. Nothing in this interface can change it.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

const VENDOR_ROLES: Role[] = ['VENDOR', 'ADMIN', 'SUPER_ADMIN'];
const ADMIN_ROLES: Role[] = ['ADMIN', 'SUPER_ADMIN'];
const FINANCE_ROLES: Role[] = ['FINANCE', 'ADMIN', 'SUPER_ADMIN'];
const MARKETING_ROLES: Role[] = ['MARKETING', 'ADMIN', 'SUPER_ADMIN'];

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* ---- Storefront (customer R1) ---------------------------------- */}
        <Route index element={<HomeScreen />} />
        <Route path="category/:slug" element={<CategoryScreen />} />
        <Route path="search" element={<SearchScreen />} />
        <Route path="product/:id" element={<ProductScreen />} />
        <Route path="deals" element={<SearchScreen />} />
        <Route path="cart" element={<CartScreen />} />
        <Route path="checkout" element={<CheckoutScreen />} />
        <Route path="order/:id/confirmed" element={<OrderConfirmedScreen />} />
        <Route path="orders" element={<OrdersScreen />} />
        <Route path="order/:id" element={<OrderDetailScreen />} />
        <Route path="returns" element={<ReturnsScreen />} />
        <Route path="wishlist" element={<WishlistScreen />} />
        <Route path="assistant" element={<AssistantScreen />} />

        {/* ---- Identity & account ---------------------------------------- */}
        <Route path="login" element={<LoginScreen />} />
        <Route path="register" element={<RegisterScreen />} />
        <Route
          path="account"
          element={
            <RequireRole
              roles={['CUSTOMER', 'VENDOR', 'ADMIN', 'SUPER_ADMIN', 'FINANCE', 'MARKETING', 'WAREHOUSE', 'DELIVERY', 'SUPPORT']}
            >
              <AccountScreen />
            </RequireRole>
          }
        />
        <Route
          path="account/addresses"
          element={
            <RequireRole roles={['CUSTOMER']}>
              <AddressesScreen />
            </RequireRole>
          }
        />
        <Route
          path="account/notifications"
          element={<NotificationsScreen />}
        />
        <Route
          path="account/wallet"
          element={
            <RequireRole roles={['CUSTOMER']}>
              <WalletScreen />
            </RequireRole>
          }
        />

        {/* ---- Vendor portal --------------------------------------------- */}
        <Route
          path="vendor"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorDashboardScreen />
            </RequireRole>
          }
        />
        <Route
          path="vendor/products"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorProductsScreen />
            </RequireRole>
          }
        />
        <Route
          path="vendor/inventory"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorInventoryScreen />
            </RequireRole>
          }
        />
        <Route
          path="vendor/orders"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorOrdersScreen />
            </RequireRole>
          }
        />
        <Route
          path="vendor/finance"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorFinanceScreen />
            </RequireRole>
          }
        />
        <Route
          path="vendor/onboarding"
          element={
            <RequireRole roles={VENDOR_ROLES}>
              <VendorOnboardingScreen />
            </RequireRole>
          }
        />

        {/* ---- Admin console --------------------------------------------- */}
        <Route
          path="admin"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminOverviewScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/approvals"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminApprovalsScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/catalogue"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminCatalogueScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/orders"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminOrdersScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/marketing"
          element={
            <RequireRole roles={MARKETING_ROLES}>
              <AdminMarketingScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/finance"
          element={
            <RequireRole roles={FINANCE_ROLES}>
              <AdminFinanceScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/users"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminUsersScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/cms"
          element={
            <RequireRole roles={MARKETING_ROLES}>
              <AdminCmsScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/audit"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminAuditScreen />
            </RequireRole>
          }
        />
        <Route
          path="admin/notifications"
          element={
            <RequireRole roles={ADMIN_ROLES}>
              <AdminNotificationsScreen />
            </RequireRole>
          }
        />

        {/* ---- Fallback -------------------------------------------------- */}
        <Route
          path="*"
          element={
            <div className="px-page">
              <h1>Page not found</h1>
              <p>The address you followed does not match a page in this release.</p>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
