import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { z } from 'zod';
import { login, registerAccount } from '@/auth/session';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { emailField, newPasswordField, personNameField } from '@/features/account/fields';

const registerSchema = z.object({
  firstName: personNameField,
  lastName: personNameField,
  email: emailField,
  password: newPasswordField,
});
type RegisterValues = z.infer<typeof registerSchema>;

const ACCOUNT_CREATED_MESSAGE = 'Konto utworzone. Zaloguj się.';

export function RegisterPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: { firstName: '', lastName: '', email: '', password: '' },
  });
  const registerMutation = useMutation({
    mutationFn: async (values: RegisterValues) => {
      await registerAccount(values);
      // Registration returns no tokens: log in with the same data. A failed login (e.g. 429) is not a failed registration.
      try {
        await login({ email: values.email, password: values.password });
        return true;
      } catch {
        return false;
      }
    },
    onSuccess: (loggedIn) => {
      // Logged in: the AnonymousOnly guard goes to returnTo (or "/").
      if (!loggedIn) navigate({ pathname: '/login', search: location.search }, { state: { notice: ACCOUNT_CREATED_MESSAGE } });
    },
  });
  const { errors } = form.formState;

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Rejestracja</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {registerMutation.isError && <ErrorAlert error={registerMutation.error} />}
        <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => registerMutation.mutate(values))}>
          <FormField id="register-first-name" label="Imię" error={errors.firstName?.message}>
            <Input id="register-first-name" autoComplete="given-name" aria-invalid={!!errors.firstName} aria-describedby="register-first-name-message" {...form.register('firstName')} />
          </FormField>
          <FormField id="register-last-name" label="Nazwisko" error={errors.lastName?.message}>
            <Input id="register-last-name" autoComplete="family-name" aria-invalid={!!errors.lastName} aria-describedby="register-last-name-message" {...form.register('lastName')} />
          </FormField>
          <FormField id="register-email" label="E-mail" error={errors.email?.message}>
            <Input id="register-email" type="email" autoComplete="email" aria-invalid={!!errors.email} aria-describedby="register-email-message" {...form.register('email')} />
          </FormField>
          <FormField id="register-password" label="Hasło" error={errors.password?.message} hint="Od 10 do 72 bajtów (polska litera liczy się za 2).">
            <Input id="register-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby="register-password-message" {...form.register('password')} />
          </FormField>
          <Button type="submit" disabled={registerMutation.isPending}>
            Załóż konto
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">
          Masz już konto?{' '}
          <Link className="underline" to={{ pathname: '/login', search: location.search }}>
            Przejdź do logowania
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
