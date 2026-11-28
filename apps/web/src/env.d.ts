interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** GEN-100: '1' = answer HTTP + the play-room socket from the mock (dev only, src/mock/boot.tsx). */
  readonly VITE_MOCK?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Vite's file glob (ISK-007 avatar pictures): eager, the default export (the file's URL) per path. */
  glob<T = () => Promise<unknown>>(pattern: string | string[], options?: { eager?: boolean; import?: string }): Record<string, T>;
}
