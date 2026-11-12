import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'react-router';
import { z } from 'zod';
import { SESSION_EXPIRED_MESSAGE, acknowledgeSessionExpiry, getSession, login } from '@/auth/session';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { emailField, loginPasswordField } from '@/features/account/fields';

const loginSchema = z.object({ email: emailField, password: loginPasswordField });
type LoginValues = z.infer<typeof loginSchema>;

/** Message passed in the navigation state (e.g. "Konto utworzone. Zaloguj się.") or the expired session. */
function initialNotice(state: unknown): string | null {
  if (typeof state === 'object' && state !== null && typeof (state as { notice?: unknown }).notice === 'string') {
    return (state as { notice: string }).notice;
  }
  return getSession().expiredRedirect ? SESSION_EXPIRED_MESSAGE : null;
}

export function LoginPage() {
  const location = useLocation();
  const [notice] = useState(() => initialNotice(location.state));
  const form = useForm<LoginValues>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  // After success the AnonymousOnly guard goes to returnTo (or "/").
  const loginMutation = useMutation({ mutationFn: login });
  const { errors } = form.formState;

  useEffect(() => {
    acknowledgeSessionExpiry();
  }, []);

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Logowanie</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {loginMutation.isError && <ErrorAlert error={loginMutation.error} />}
        <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => loginMutation.mutate(values))}>
          <FormField id="login-email" label="E-mail" error={errors.email?.message}>
            <Input id="login-email" type="email" autoComplete="email" aria-invalid={!!errors.email} aria-describedby="login-email-message" {...form.register('email')} />
          </FormField>
          <FormField id="login-password" label="Hasło" error={errors.password?.message}>
            <Input id="login-password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} aria-describedby="login-password-message" {...form.register('password')} />
          </FormField>
          <Button type="submit" disabled={loginMutation.isPending}>
            Zaloguj się
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">
          Nie masz konta?{' '}
          <Link className="underline" to={{ pathname: '/register', search: location.search }}>
            Załóż konto
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
