// Railway Infrastructure as Code for the API service (GEN-041a). See docs/deploy.md.
//
// Railway does NOT read this file during deploys: `railway config plan` shows the changes and
// `railway config apply` applies them (Railway CLI). Without the CLI, set the same values in the
// dashboard by hand (docs/deploy.md, step 1). railway.json / railway.toml (Config as Code) is
// deprecated: new services cannot use it and it stops being read on 2026-12-01.
//
// Keys come from the `railway` SDK 3.17.0 types (railway/iac), a root devDependency (Q-064).
// `pnpm run typecheck:infra` (also part of `pnpm run lint`) type-checks this file.
//
// Secrets never go here: values Railway already holds are kept with preserve().
import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

/** Branch Railway deploys on every push (open question for Nok: main or develop). */
const DEPLOY_BRANCH = 'main';

/** Where the volume is mounted in the container; the SQLite file lives inside it. */
const VOLUME_MOUNT = '/data';

export default defineRailway(() => {
  const data = volume('isekai-data', { sizeMB: 1024 });

  const api = service('isekai-server', {
    // Repo root, not apps/server: the pnpm workspace (lockfile, packages/protocol) is needed to build.
    source: github('kwpinthong/DnD-AI-Game-Master-Project', { branch: DEPLOY_BRANCH }),
    build: {
      builder: 'RAILPACK',
      // Railpack runs `pnpm install` first; this fails the build on a type error before anything deploys.
      buildCommand: 'pnpm --filter "@isekai/server..." run typecheck',
      // Commits that touch only the web app do not redeploy the server.
      watchPatterns: [
        'apps/server/**',
        'packages/**',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'tsconfig.base.json',
        '.railway/**',
      ],
    },
    deploy: {
      // Migrations run here, at start, against the DB on the volume. Not as a pre-deploy command:
      // Railway runs that in a separate container without volumes, so it would migrate a throwaway file.
      startCommand: 'node apps/server/src/index.ts',
      healthcheckPath: '/health',
      healthcheckTimeout: 60,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // SQLite on one volume: exactly one replica (Railway does not allow replicas with a volume).
      numReplicas: 1,
    },
    volumeMounts: { [VOLUME_MOUNT]: data },
    env: {
      NODE_ENV: 'production',
      DB_PATH: `${VOLUME_MOUNT}/isekai.sqlite`,
      // Backup job (GEN-037): every 6 h + at shutdown, newest 28 kept (defaults), on the volume next to the DB.
      BACKUP_DIR: `${VOLUME_MOUNT}/backups`,
      // engines.node is ">=26"; pin the major so Railpack does not pick a newer non-LTS Node.
      RAILPACK_NODE_VERSION: '26',
      // https://<site>.netlify.app, set in the dashboard once the Netlify site exists.
      WEB_ORIGIN: preserve(),
      // scrypt hash of the create code (Q-021) from `create-code:hash`; set in the dashboard, never in the repo.
      CREATE_CODE_HASH: preserve(),
      // scrypt hash of the server owner's admin code (GEN-061) from `admin-code:hash`; opens the AI usage dashboard.
      ADMIN_CODE_HASH: preserve(),
      // Secret for the AI GM (GEN-038); without it games cannot be created or started (Q-075).
      ANTHROPIC_API_KEY: preserve(),
    },
  });

  return project('isekai-chronicles', { resources: [api, data] });
});
