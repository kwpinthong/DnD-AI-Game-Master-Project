/**
 * GEN-090: parts of the pre-game pages whose backend is still pending in the GEN-099 contract (the memory toggle
 * of GEN-083; GEN-082's player code + style opt-out on the join form are live). They are built on the contract
 * schema and shown only in mock mode, so the real site has no control that does nothing.
 */
export const PENDING_BACKEND_UI: boolean = import.meta.env.DEV && import.meta.env.VITE_MOCK === '1';
