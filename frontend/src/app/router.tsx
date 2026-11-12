// All routes of the shop (wytyczne 3.6). Wave 2 replaces page contents in src/features/*, not this file.
// Browser router without framework mode or SSR.
import { Suspense, type ComponentType } from 'react';
import { Navigate, createBrowserRouter, type RouteObject } from 'react-router';
import { AppLayout } from '@/app/layout/AppLayout';
import { NotFoundPage } from '@/app/pages/NotFoundPage';
import { RouteErrorPage } from '@/app/pages/RouteErrorPage';
import { AnonymousOnly, RequireAdmin, RequireAuth } from '@/auth/guards';
import { PageLoading } from '@/components/PageLoading';
import { AccountPage } from '@/features/account/AccountPage';
import { LoginPage } from '@/features/account/LoginPage';
import { RegisterPage } from '@/features/account/RegisterPage';
import { CartPage } from '@/features/cart/CartPage';
import { CatalogPage } from '@/features/catalog/CatalogPage';
import { OrderDetailPage } from '@/features/orders/OrderDetailPage';
import { OrdersPage } from '@/features/orders/OrdersPage';
import { ProductPage } from '@/features/product/ProductPage';
import { lazyPage } from '@/lib/lazy-page';

// Admin pages and checkout load lazily (Z18): customers do not download the admin panel, and a chunk
// loads only after the guard lets the user in. A failed chunk load ends in RouteErrorPage.
const AdminProductFormPage = lazyPage(() => import('@/features/admin/AdminProductFormPage'), 'AdminProductFormPage');
const AdminProductsPage = lazyPage(() => import('@/features/admin/AdminProductsPage'), 'AdminProductsPage');
const AdminShipmentsPage = lazyPage(() => import('@/features/admin/AdminShipmentsPage'), 'AdminShipmentsPage');
const CheckoutPage = lazyPage(() => import('@/features/checkout/CheckoutPage'), 'CheckoutPage');

const lazyElement = (Page: ComponentType) => (
  <Suspense fallback={<PageLoading />}>
    <Page />
  </Suspense>
);

// Every page has its own error boundary: an error of one page keeps the header and the other pages working.
const pageError = <RouteErrorPage />;

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: pageError,
    children: [
      { index: true, element: <CatalogPage />, errorElement: pageError },
      { path: 'products/:productId', element: <ProductPage />, errorElement: pageError },
      {
        element: <AnonymousOnly />,
        children: [
          { path: 'login', element: <LoginPage />, errorElement: pageError },
          { path: 'register', element: <RegisterPage />, errorElement: pageError },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: 'account', element: <AccountPage />, errorElement: pageError },
          { path: 'cart', element: <CartPage />, errorElement: pageError },
          { path: 'checkout', element: lazyElement(CheckoutPage), errorElement: pageError },
          { path: 'orders', element: <OrdersPage />, errorElement: pageError },
          { path: 'orders/:orderId', element: <OrderDetailPage />, errorElement: pageError },
        ],
      },
      {
        path: 'admin',
        element: <RequireAdmin />,
        children: [
          { index: true, element: <Navigate to="/admin/products" replace /> },
          { path: 'products', element: lazyElement(AdminProductsPage), errorElement: pageError },
          { path: 'products/new', element: lazyElement(AdminProductFormPage), errorElement: pageError },
          { path: 'products/:productId', element: lazyElement(AdminProductFormPage), errorElement: pageError },
          { path: 'shipments', element: lazyElement(AdminShipmentsPage), errorElement: pageError },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
