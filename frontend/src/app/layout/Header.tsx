import { SearchIcon, ShoppingCartIcon, StoreIcon } from 'lucide-react';
import type { FormEvent } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { useCart } from '@/api/cart';
import { logout, useSession } from '@/auth/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function SearchForm() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim();
    navigate(value ? `/?q=${encodeURIComponent(value)}` : '/');
  }

  return (
    <form role="search" onSubmit={onSubmit} className="flex min-w-0 flex-1 items-center gap-2">
      <Input key={q} name="q" type="search" defaultValue={q} placeholder="Szukaj produktów" aria-label="Szukaj produktów" maxLength={200} />
      <Button type="submit" variant="outline" size="icon" aria-label="Szukaj">
        <SearchIcon />
      </Button>
    </form>
  );
}

function CartLink() {
  const cart = useCart();
  // Without a cart (anonymous, error, loading) the link has no number.
  const count = cart.data?.items.length;
  return (
    <Button asChild variant="ghost">
      <Link to="/cart">
        <ShoppingCartIcon />
        <span>Koszyk</span>
        {count !== undefined && <Badge variant="secondary">{count}</Badge>}
      </Link>
    </Button>
  );
}

const LOGOUT_FAILED_MESSAGE = 'Nie udało się wylogować. Spróbuj ponownie za chwilę.';

export function Header() {
  const session = useSession();
  const navigate = useNavigate();

  async function onLogout() {
    try {
      await logout();
    } catch {
      // The session stays (the refresh cookie is still valid), so the user has to know and try again (Z19a).
      toast.error(LOGOUT_FAILED_MESSAGE);
      return;
    }
    navigate('/');
  }

  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 text-lg font-semibold">
          <StoreIcon className="size-5" />
          Sklep
        </Link>
        <SearchForm />
        <nav aria-label="Konto" className="flex flex-wrap items-center gap-1">
          <CartLink />
          {session.status === 'authenticated' && (
            <>
              <Button asChild variant="ghost">
                <NavLink to="/account">Moje konto</NavLink>
              </Button>
              <Button asChild variant="ghost">
                <NavLink to="/orders">Zamówienia</NavLink>
              </Button>
              {session.roles.includes('ADMIN') && (
                <Button asChild variant="ghost">
                  <NavLink to="/admin/products">Panel admina</NavLink>
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onLogout}>
                Wyloguj
              </Button>
            </>
          )}
          {session.status === 'anonymous' && (
            <>
              <Button asChild variant="ghost">
                <NavLink to="/login">Zaloguj</NavLink>
              </Button>
              <Button asChild>
                <NavLink to="/register">Zarejestruj</NavLink>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
