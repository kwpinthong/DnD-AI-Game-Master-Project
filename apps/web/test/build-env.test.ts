import { describe, expect, it } from 'vitest';
import { checkBuildEnv } from '../build-env.ts';

// The web app on Netlify only reaches the server through VITE_API_URL, baked in at build time.
describe('checkBuildEnv (vite build)', () => {
  it('fails a Netlify build without VITE_API_URL, naming the variable', () => {
    expect(() => checkBuildEnv({ NETLIFY: 'true' })).toThrow(/VITE_API_URL/);
    expect(() => checkBuildEnv({ NETLIFY: 'true', VITE_API_URL: ' ' })).toThrow(/VITE_API_URL/);
  });

  it('fails a Netlify build whose VITE_API_URL is not https (the browser would block it from an https page)', () => {
    expect(() => checkBuildEnv({ NETLIFY: 'true', VITE_API_URL: 'http://isekai.up.railway.app' })).toThrow(
      /VITE_API_URL/,
    );
    expect(() => checkBuildEnv({ NETLIFY: 'true', VITE_API_URL: 'isekai.up.railway.app' })).toThrow(/VITE_API_URL/);
  });

  it('passes a Netlify build with an https VITE_API_URL', () => {
    expect(() => checkBuildEnv({ NETLIFY: 'true', VITE_API_URL: 'https://isekai.up.railway.app' })).not.toThrow();
  });

  it('lets a local build run without VITE_API_URL (same-origin dev proxy)', () => {
    expect(() => checkBuildEnv({})).not.toThrow();
  });
});
