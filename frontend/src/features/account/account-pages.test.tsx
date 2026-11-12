import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server, setupMockServer } from '@/mocks/node';
import { renderApp } from '@/test/render-app';

setupMockServer();

const CUSTOMER = { email: 'klient@sklep.test', password: 'Klient-atrapa-1' };

function tooManyResponse(error: 'TOO_MANY_ATTEMPTS' | 'TOO_MANY_REQUESTS', retryAfter: number) {
  return HttpResponse.json({ status: 429, error, message: 'test', requestId: 'rid-429' }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
}

async function fillLogin(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('E-mail', { exact: true }), email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), password);
  await user.click(screen.getByRole('button', { name: 'Zaloguj się' }));
}

async function fillRegister(values: { firstName: string; lastName: string; email: string; password: string }) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Imię', { exact: true }), values.firstName);
  await user.type(screen.getByLabelText('Nazwisko', { exact: true }), values.lastName);
  await user.type(screen.getByLabelText('E-mail', { exact: true }), values.email);
  await user.type(screen.getByLabelText('Hasło', { exact: true }), values.password);
  await user.click(screen.getByRole('button', { name: 'Załóż konto' }));
}

describe('login page', () => {
  it('logs in and goes to returnTo', async () => {
    const { router } = await renderApp('/login?returnTo=%2Faccount');

    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/account'));
    expect(await screen.findByRole('button', { name: 'Wyloguj' })).toBeInTheDocument();
  });

  it('shows the message for a wrong password', async () => {
    await renderApp('/login');

    await fillLogin(CUSTOMER.email, 'Zle-haslo-123');

    expect(await screen.findByText('Nieprawidłowy e-mail lub hasło.')).toBeInTheDocument();
  });

  it('validates before sending: e-mail with @, password up to 72 bytes', async () => {
    const login = vi.fn();
    server.use(http.post('*/api/v1/auth/login', login));
    await renderApp('/login');

    await fillLogin('klient.sklep.test', 'ą'.repeat(37));

    expect(await screen.findByText('Podaj poprawny adres e-mail.')).toBeInTheDocument();
    expect(screen.getByText('Hasło może mieć najwyżej 72 bajty (polska litera liczy się za 2).')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('TOO_MANY_ATTEMPTS shows the lock time in minutes', async () => {
    server.use(http.post('*/api/v1/auth/login', () => tooManyResponse('TOO_MANY_ATTEMPTS', 840)));
    await renderApp('/login');

    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByText('Konto jest czasowo zablokowane. Spróbuj ponownie za 14 min.')).toBeInTheDocument();
    expect(screen.getByText('Kod zgłoszenia: rid-429')).toBeInTheDocument();
  });

  it('TOO_MANY_REQUESTS shows the wait time in seconds from Retry-After', async () => {
    server.use(http.post('*/api/v1/auth/login', () => tooManyResponse('TOO_MANY_REQUESTS', 37)));
    await renderApp('/login');

    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByText('Zbyt wiele prób. Spróbuj ponownie za 37 s.')).toBeInTheDocument();
  });
});

describe('register page', () => {
  it('rejects a password shorter than 10 bytes and accepts 10 bytes of Polish letters', async () => {
    const register = vi.fn(() => HttpResponse.json({ status: 400, error: 'VALIDATION_ERROR', message: 'x', requestId: 'r' }, { status: 400 }));
    server.use(http.post('*/api/v1/auth/register', register));
    await renderApp('/register');

    await fillRegister({ firstName: 'Anna', lastName: 'Nowak', email: 'anna@example.com', password: 'Krótkie1' });
    expect(await screen.findByText('Hasło musi mieć co najmniej 10 znaków.')).toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();

    const user = userEvent.setup();
    const password = screen.getByLabelText('Hasło', { exact: true });
    await user.clear(password);
    await user.type(password, 'ąęółź');
    await user.click(screen.getByRole('button', { name: 'Załóż konto' }));
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));
  });

  it('shows the message for an e-mail that is taken', async () => {
    await renderApp('/register');

    await fillRegister({ firstName: 'Jan', lastName: 'Kowalski', email: CUSTOMER.email, password: 'Nowe-haslo-123' });

    expect(await screen.findByText('Konto z tym adresem e-mail już istnieje.')).toBeInTheDocument();
  });

  it('logs in automatically after registration', async () => {
    const { router } = await renderApp('/register');

    await fillRegister({ firstName: 'Anna', lastName: 'Nowak', email: 'anna.nowak@example.com', password: 'Haslo-anny-123' });

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/'));
    const nav = await screen.findByRole('navigation', { name: 'Konto' });
    expect(await within(nav).findByRole('button', { name: 'Wyloguj' })).toBeInTheDocument();
  });

  it('when the login after registration fails, goes to the login page with "Konto utworzone. Zaloguj się."', async () => {
    server.use(http.post('*/api/v1/auth/login', () => tooManyResponse('TOO_MANY_REQUESTS', 30)));
    const { router } = await renderApp('/register?returnTo=%2Forders');

    await fillRegister({ firstName: 'Ola', lastName: 'Lis', email: 'ola.lis@example.com', password: 'Haslo-oli-1234' });

    expect(await screen.findByText('Konto utworzone. Zaloguj się.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?returnTo=%2Forders');
  });
});

describe('account page', () => {
  it('shows the profile and the addresses of the customer', async () => {
    await renderApp('/login?returnTo=%2Faccount');
    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByRole('heading', { name: 'Moje konto' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Jan')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail', { exact: true })).toHaveValue(CUSTOMER.email);
  });

  it('ADMIN without a customer profile sees a message instead of the profile', async () => {
    await renderApp('/login?returnTo=%2Faccount');
    await fillLogin('admin@sklep.test', 'Admin-atrapa-1');

    expect(await screen.findByText('Konto administratora nie ma profilu klienta.')).toBeInTheDocument();
  });

  it('CUSTOMER without a profile (404) sees a message for a customer, not the admin one (Z19e)', async () => {
    server.use(http.get('*/api/v1/users/me', () => HttpResponse.json({ status: 404, error: 'NOT_FOUND', message: 'x', requestId: 'rid-404' }, { status: 404 })));
    await renderApp('/login?returnTo=%2Faccount');
    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByText('Profil klienta nie istnieje. Skontaktuj się z obsługą sklepu.')).toBeInTheDocument();
    expect(screen.queryByText('Konto administratora nie ma profilu klienta.')).not.toBeInTheDocument();
  });

  it('the delete button of an address names the address (C25)', async () => {
    await renderApp('/login?returnTo=%2Faccount');
    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByRole('button', { name: 'Usuń adres ul. Testowa 1, 00-001 Warszawa' })).toHaveTextContent('Usuń');
  });

  it('User Service unavailable shows the message with "Spróbuj ponownie"', async () => {
    server.use(http.get('*/api/v1/users/me', () => HttpResponse.json({ status: 503, error: 'SERVICE_UNAVAILABLE', message: 'x', requestId: 'rid-503' }, { status: 503 })));
    await renderApp('/login?returnTo=%2Faccount');
    await fillLogin(CUSTOMER.email, CUSTOMER.password);

    expect(await screen.findByText('Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Spróbuj ponownie' })).toBeInTheDocument();
  });
});
