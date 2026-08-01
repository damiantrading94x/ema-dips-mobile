/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** VAPID public key baked in at build time; public by design. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
