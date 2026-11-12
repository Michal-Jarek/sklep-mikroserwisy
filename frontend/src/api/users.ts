// Profile and addresses of the logged-in customer (User Service): /account and checkout.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/api/client';
import { paths } from '@/api/paths';
import type { Address, AddressRequest, UpdateProfileRequest, UserProfile } from '@/api/types';

export const userKeys = {
  all: ['users'] as const,
  profile: () => [...userKeys.all, 'me'] as const,
  addresses: () => [...userKeys.all, 'me', 'addresses'] as const,
};

/** GET /users/me; 404 for ADMIN (no customer profile). */
export function useProfile() {
  return useQuery({
    queryKey: userKeys.profile(),
    queryFn: ({ signal }) => apiRequest<UserProfile>(paths.users.me, { signal }),
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileRequest) => apiRequest<UserProfile>(paths.users.me, { method: 'PUT', body }),
    onSuccess: (profile) => queryClient.setQueryData(userKeys.profile(), profile),
  });
}

export function useAddresses(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: userKeys.addresses(),
    queryFn: ({ signal }) => apiRequest<Address[]>(paths.users.addresses, { signal }),
    enabled: options.enabled,
  });
}

export function useAddAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AddressRequest) => apiRequest<Address>(paths.users.addresses, { method: 'POST', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.addresses() }),
  });
}

export function useDeleteAddress() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (addressId: string) => apiRequest<void>(paths.users.address(addressId), { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.addresses() }),
  });
}
