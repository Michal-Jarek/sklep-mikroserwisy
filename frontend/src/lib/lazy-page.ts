// Lazy pages (Z18): the admin panel and checkout are separate chunks. After a new deployment the old
// chunk under /assets is gone (404, K12), so the import fails; RouteErrorPage shows "refresh the page".
import { lazy, type ComponentType } from 'react';

/** The code of a lazy page could not be loaded. */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super('Page code could not be loaded', { cause });
    this.name = 'PageLoadError';
  }
}

/** `React.lazy` for a named export; a failed import becomes `PageLoadError`. */
export function lazyPage<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): ComponentType {
  return lazy(async (): Promise<{ default: ComponentType }> => {
    try {
      return { default: (await load())[name] };
    } catch (error) {
      throw new PageLoadError(error);
    }
  });
}
