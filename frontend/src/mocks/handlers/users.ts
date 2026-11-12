// Mock User: profile and addresses of the logged-in account (contract: docs/frontend-api.md, section User).
import type { Address, UserProfile } from '../../api/types';
import type { MockState } from '../db';
import { badRequest, json, noContent, notFound, requireIdentity, route, type Identity } from '../http';
import { pathUuid, readBody, text } from '../validation';

const COUNTRY_CODE = /^[A-Z]{2}$/;

/**
 * Profile of the caller. A CUSTOMER token for an account the mocks do not know (list mode with the real Auth)
 * gets a placeholder profile on first use, so the shop works with real accounts. ADMIN has no profile (404).
 */
function profileOf(state: MockState, identity: Identity): UserProfile {
  const existing = state.profiles.find((p) => p.id === identity.userId);
  if (existing) {
    return existing;
  }
  if (!identity.roles.includes('CUSTOMER')) {
    throw notFound('Profile not found');
  }
  const created: UserProfile = {
    id: identity.userId,
    firstName: 'Klient',
    lastName: 'Testowy',
    email: `konto-${identity.userId.slice(0, 8)}@atrapa.test`,
  };
  state.profiles.push(created);
  return created;
}

const addressView = ({ id, street, city, postalCode, countryCode }: Address): Address => ({
  id,
  street,
  city,
  postalCode,
  countryCode,
});

export const userHandlers = [
  route('GET', '/users/me', (ctx) => json(profileOf(ctx.state, requireIdentity(ctx)))),

  route('PUT', '/users/me', async (ctx) => {
    const body = await readBody(ctx.request, ['firstName', 'lastName']);
    const firstName = text(body.firstName, 'firstName', 1, 100);
    const lastName = text(body.lastName, 'lastName', 1, 100);
    const profile = profileOf(ctx.state, requireIdentity(ctx));
    profile.firstName = firstName;
    profile.lastName = lastName;
    return json(profile);
  }),

  route('GET', '/users/me/addresses', (ctx) => {
    const profile = profileOf(ctx.state, requireIdentity(ctx));
    return json(ctx.state.addresses.filter((a) => a.userId === profile.id).map(addressView));
  }),

  route('POST', '/users/me/addresses', async (ctx) => {
    const body = await readBody(ctx.request, ['street', 'city', 'postalCode', 'countryCode']);
    const street = text(body.street, 'street', 1, 200);
    const city = text(body.city, 'city', 1, 100);
    const postalCode = text(body.postalCode, 'postalCode', 1, 20);
    const countryCode = text(body.countryCode, 'countryCode', 2, 2);
    if (!COUNTRY_CODE.test(countryCode)) {
      throw badRequest('countryCode must be two capital letters');
    }
    const profile = profileOf(ctx.state, requireIdentity(ctx));
    const address = { id: crypto.randomUUID(), userId: profile.id, street, city, postalCode, countryCode };
    ctx.state.addresses.push(address);
    return json(addressView(address), 201);
  }),

  route('DELETE', '/users/me/addresses/:addressId', (ctx) => {
    const addressId = pathUuid(ctx.params, 'addressId');
    const profile = profileOf(ctx.state, requireIdentity(ctx));
    const index = ctx.state.addresses.findIndex((a) => a.id === addressId && a.userId === profile.id);
    if (index < 0) {
      throw notFound('Address not found');
    }
    ctx.state.addresses.splice(index, 1);
    return noContent();
  }),
];
