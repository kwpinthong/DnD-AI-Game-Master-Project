/**
 * Stops a Netlify build (NETLIFY=true) that would ship a web app unable to reach the server:
 * VITE_API_URL must be the server's https URL (Railway). Local builds may leave it empty.
 */
export function checkBuildEnv(env: Record<string, string | undefined>): void {
  if (env.NETLIFY !== 'true') return;
  const url = env.VITE_API_URL?.trim();
  if (!url) {
    throw new Error('VITE_API_URL is not set: add the Railway URL in Netlify > Site configuration > Environment variables');
  }
  let protocol = '';
  try {
    protocol = new URL(url).protocol;
  } catch {
    // reported below
  }
  if (protocol !== 'https:') {
    throw new Error(`VITE_API_URL must be an https URL like https://<service>.up.railway.app, got "${url}"`);
  }
}
