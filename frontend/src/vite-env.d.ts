/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "" or missing: no mocks; "all": every resource; otherwise a comma-separated list of resources. Only in `vite` (dev). */
  readonly VITE_API_MOCKS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
