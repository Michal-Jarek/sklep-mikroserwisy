// Z17 (b): an image address from the API goes to <img src> only when it is https
// (with mocks also data:image/, the seed uses inline SVG); anything else shows the placeholder.

/** Address safe for `<img src>`, or null (show the placeholder). */
export function imageSrc(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  if (import.meta.env.VITE_API_MOCKS && url.startsWith('data:image/')) return url;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
