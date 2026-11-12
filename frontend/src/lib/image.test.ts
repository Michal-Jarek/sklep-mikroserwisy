import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageSrc } from '@/lib/image';

const SVG = 'data:image/svg+xml,%3Csvg%2F%3E';

describe('imageSrc', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps an https address', () => {
    expect(imageSrc('https://img.example.com/a.jpg')).toBe('https://img.example.com/a.jpg');
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['http:', 'http://img.example.com/a.jpg'],
    ['data:text/html', 'data:text/html,<script>alert(1)</script>'],
    ['protocol-relative', '//evil.example.com/a.jpg'],
    ['relative path', '/api/v1/a.jpg'],
    ['empty', ''],
    ['https without host', 'https://'],
  ])('%s → null', (_name, url) => {
    expect(imageSrc(url)).toBeNull();
  });

  it('null and undefined → null', () => {
    expect(imageSrc(null)).toBeNull();
    expect(imageSrc(undefined)).toBeNull();
  });

  it('data:image/ only with mocks', () => {
    vi.stubEnv('VITE_API_MOCKS', '');
    expect(imageSrc(SVG)).toBeNull();
    vi.stubEnv('VITE_API_MOCKS', 'all');
    expect(imageSrc(SVG)).toBe(SVG);
    expect(imageSrc('data:text/html,x')).toBeNull();
  });
});
