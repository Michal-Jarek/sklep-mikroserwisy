import { expect, test } from '../compose/helpers';

// Catalog through https://shop.localhost without logging in. The full cluster (`up.sh all`, from part 7c of stage 7
// on) runs Product Service: the list answers 200 and the page shows the product cards; anything else fails.
// Only with E2E_K8S_PLATFORM_ONLY=1 (layer `platform` alone, part 7b: no Product Service) the API Gateway answers
// 503 SERVICE_UNAVAILABLE (with its request id) and the page shows the unavailable message. The state seen is
// written to the test annotations (list reporter, HTML report).
const UNAVAILABLE = 'Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.';
const PLATFORM_ONLY = process.env.E2E_K8S_PLATFORM_ONLY === '1';

test('catalog: the page loads and shows the products (with E2E_K8S_PLATFORM_ONLY=1: the unavailable message)', async ({ page }) => {
  const isProducts = (url: string) => new URL(url).pathname === '/api/v1/products';
  const firstAnswer = page.waitForResponse((response) => isProducts(response.url()) && response.request().method() === 'GET');

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Katalog' })).toBeVisible();

  const response = await firstAnswer;
  // The API Gateway answered (not Traefik with "no available server"): every Gateway answer has X-Request-Id.
  expect(response.headers()['x-request-id']).toBeTruthy();
  test.info().annotations.push({ type: 'catalog', description: `GET /api/v1/products → ${response.status()}` });

  if (PLATFORM_ONLY) {
    expect(response.status()).toBe(503);
    expect(await response.json()).toMatchObject({ status: 503, error: 'SERVICE_UNAVAILABLE' });
    await expect(page.getByText(UNAVAILABLE)).toBeVisible();
    await expect(page.getByText(/^Kod zgłoszenia: \S+/)).toBeVisible();
  } else {
    expect(response.status()).toBe(200);
    await expect(page.getByRole('list', { name: 'Produkty' }).getByRole('listitem').first()).toBeVisible();
  }
});
