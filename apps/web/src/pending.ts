/**
 * GEN-090: parts of the pre-game pages whose backend is still pending in the GEN-099 contract (player code +
 * style opt-out of GEN-082, the memory toggle of GEN-083). They are built on the contract schema and shown
 * only in mock mode, so the real site has no control that does nothing. GEN-102 turns them on for real.
 */
export const PENDING_BACKEND_UI: boolean = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';
