import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { ApiError } from '@/api/errors';
import type { UserProfile } from '@/api/types';
import { useAddAddress, useAddresses, useDeleteAddress, useProfile, useUpdateProfile } from '@/api/users';
import { useSession } from '@/auth/session';
import { ErrorAlert } from '@/components/ErrorAlert';
import { FormField } from '@/components/FormField';
import { PageLoading } from '@/components/PageLoading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { addressSchema, personNameField } from '@/features/account/fields';

const profileSchema = z.object({ firstName: personNameField, lastName: personNameField });
type ProfileValues = z.infer<typeof profileSchema>;
type AddressValues = z.input<typeof addressSchema>;

function ProfileForm({ profile }: { profile: UserProfile }) {
  const update = useUpdateProfile();
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { firstName: profile.firstName, lastName: profile.lastName },
  });
  const { errors } = form.formState;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Dane</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {update.isError && <ErrorAlert error={update.error} />}
        <form noValidate className="grid gap-4" onSubmit={form.handleSubmit((values) => update.mutate(values, { onSuccess: () => toast.success('Zapisano dane.') }))}>
          <FormField id="profile-first-name" label="Imię" error={errors.firstName?.message}>
            <Input id="profile-first-name" autoComplete="given-name" aria-invalid={!!errors.firstName} aria-describedby="profile-first-name-message" {...form.register('firstName')} />
          </FormField>
          <FormField id="profile-last-name" label="Nazwisko" error={errors.lastName?.message}>
            <Input id="profile-last-name" autoComplete="family-name" aria-invalid={!!errors.lastName} aria-describedby="profile-last-name-message" {...form.register('lastName')} />
          </FormField>
          <FormField id="profile-email" label="E-mail">
            <Input id="profile-email" type="email" value={profile.email} readOnly />
          </FormField>
          <Button type="submit" className="justify-self-start" disabled={update.isPending}>
            Zapisz
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function AddAddressForm() {
  const add = useAddAddress();
  const form = useForm<AddressValues, unknown, z.output<typeof addressSchema>>({
    resolver: zodResolver(addressSchema),
    defaultValues: { street: '', city: '', postalCode: '', countryCode: 'PL' },
  });
  const { errors } = form.formState;

  function onSubmit(values: z.output<typeof addressSchema>) {
    add.mutate(values, {
      onSuccess: () => {
        form.reset();
        toast.success('Dodano adres.');
      },
    });
  }

  return (
    <form noValidate className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit(onSubmit)}>
      {add.isError && <ErrorAlert className="sm:col-span-2" error={add.error} />}
      <FormField id="address-street" label="Ulica i numer" error={errors.street?.message}>
        <Input id="address-street" autoComplete="street-address" aria-invalid={!!errors.street} aria-describedby="address-street-message" {...form.register('street')} />
      </FormField>
      <FormField id="address-city" label="Miasto" error={errors.city?.message}>
        <Input id="address-city" autoComplete="address-level2" aria-invalid={!!errors.city} aria-describedby="address-city-message" {...form.register('city')} />
      </FormField>
      <FormField id="address-postal-code" label="Kod pocztowy" error={errors.postalCode?.message}>
        <Input id="address-postal-code" autoComplete="postal-code" aria-invalid={!!errors.postalCode} aria-describedby="address-postal-code-message" {...form.register('postalCode')} />
      </FormField>
      <FormField id="address-country" label="Kraj (kod z 2 liter)" error={errors.countryCode?.message}>
        <Input id="address-country" autoComplete="country" maxLength={2} aria-invalid={!!errors.countryCode} aria-describedby="address-country-message" {...form.register('countryCode')} />
      </FormField>
      <Button type="submit" className="justify-self-start" disabled={add.isPending}>
        Dodaj adres
      </Button>
    </form>
  );
}

function Addresses() {
  const addresses = useAddresses();
  const remove = useDeleteAddress();

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Adresy</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {addresses.isPending && <PageLoading />}
        {addresses.isError && <ErrorAlert error={addresses.error} onRetry={() => void addresses.refetch()} />}
        {remove.isError && <ErrorAlert error={remove.error} />}
        {addresses.data?.length === 0 && <p className="text-muted-foreground">Nie masz zapisanych adresów.</p>}
        {addresses.data && addresses.data.length > 0 && (
          <ul className="grid gap-2">
            {addresses.data.map((address) => (
              <li key={address.id} className="flex items-center justify-between gap-4 rounded-md border p-3">
                <span>
                  {address.street}, {address.postalCode} {address.city}, {address.countryCode}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Usuń adres ${address.street}, ${address.postalCode} ${address.city}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(address.id)}
                >
                  Usuń
                </Button>
              </li>
            ))}
          </ul>
        )}
        <AddAddressForm />
      </CardContent>
    </Card>
  );
}

export function AccountPage() {
  const profile = useProfile();
  const { roles } = useSession();

  let content;
  if (profile.isPending) {
    content = <PageLoading />;
  } else if (profile.isError && profile.error instanceof ApiError && profile.error.status === 404) {
    // ADMIN accounts have no customer profile in User Service; for a customer it is a missing profile (Z19e).
    content = (
      <Alert>
        <AlertDescription>
          {roles.includes('ADMIN') ? 'Konto administratora nie ma profilu klienta.' : 'Profil klienta nie istnieje. Skontaktuj się z obsługą sklepu.'}
        </AlertDescription>
      </Alert>
    );
  } else if (profile.isError) {
    content = <ErrorAlert error={profile.error} onRetry={() => void profile.refetch()} />;
  } else {
    content = (
      <>
        <ProfileForm profile={profile.data} />
        <Addresses />
      </>
    );
  }

  return (
    <section className="grid max-w-3xl gap-6">
      <h1 className="text-2xl font-semibold">Moje konto</h1>
      {content}
    </section>
  );
}
