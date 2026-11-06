#!/usr/bin/env node
/**
 * Creates the GitHub repository (if needed) and pushes `main`.
 *
 *   set GITHUB_TOKEN=ghp_xxx            (classic token: repo + workflow scopes)
 *   node scripts/push.mjs --owner your-username --repo dealerama --private
 *
 * or:
 *   node scripts/push.mjs --token ghp_xxx --owner your-username
 *
 * The token is only used for the two API calls and the push. It is passed to git
 * as an ephemeral Authorization header, never written to .git/config, and the
 * remote is stored without any credential.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './configure.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const raw = a.slice(2);
    const eq = raw.indexOf('=');
    const key = eq > 0 ? raw.slice(0, eq) : raw;
    if (['help', 'private', 'public', 'force'].includes(key)) {
      out[key] = true;
      continue;
    }
    out[key] = eq > 0 ? raw.slice(eq + 1) : argv[++i];
  }
  return out;
}

const HELP = `
Dealerama push

  --token <pat>     GitHub token (classic: repo + workflow)   (env GITHUB_TOKEN)
  --owner <login>   account that will own the repo           (env GITHUB_OWNER)
  --repo <name>     repository name (default: dealerama)
  --private         private repository (default)
  --public          public repository
  --force           overwrite the remote branch (only if you mean it)
  --env-file <path> read GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO from a file
                    (default: .env.local)
  --help
`;

async function api(fetchImpl, path, token, init = {}) {
  const res = await fetchImpl(API + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dealerama-push',
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

export async function push(opts, { fetchImpl = fetch, log = () => {}, run } = {}) {
  const token = String(opts.token || process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('Missing token: pass --token or set GITHUB_TOKEN.');
  const repoName = String(opts.repo || process.env.GITHUB_REPO || 'dealerama').trim();
  const isPrivate = opts.public ? false : true;

  const me = await api(fetchImpl, '/user', token);
  if (me.status === 401) throw new Error('GitHub rejected the token (401). Check it has not expired.');
  if (me.status !== 200) throw new Error('Could not read /user: HTTP ' + me.status + ' ' + JSON.stringify(me.data).slice(0, 200));
  const login = me.data.login;
  const owner = String(opts.owner || process.env.GITHUB_OWNER || login).trim();
  log('Authenticated as ' + login + '; target repo ' + owner + '/' + repoName);

  const existing = await api(fetchImpl, '/repos/' + owner + '/' + repoName, token);
  let created = false;

  if (existing.status === 404) {
    const payload = {
      name: repoName,
      description: 'Dealerama — Chrome extension + Netlify function + Google Apps Script deal store',
      private: isPrivate,
      has_issues: true,
      has_wiki: false,
      auto_init: false
    };
    const endpoint = owner === login ? '/user/repos' : '/orgs/' + owner + '/repos';
    const made = await api(fetchImpl, endpoint, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (made.status === 403) {
      throw new Error(
        'GitHub refused to create the repository (403). The token needs "Administration: write" ' +
          '(fine-grained, all repositories) or the classic "repo" scope. ' +
          'Alternatively create an empty repo manually and re-run this script.'
      );
    }
    if (made.status === 422) throw new Error('GitHub says that name is invalid or already taken (422).');
    if (made.status !== 201) throw new Error('Create failed: HTTP ' + made.status + ' ' + JSON.stringify(made.data).slice(0, 200));
    log('Created ' + made.data.full_name + ' (' + (isPrivate ? 'private' : 'public') + ')');
    created = true;
  } else if (existing.status === 200) {
    log('Repository already exists — pushing into it.');
  } else {
    throw new Error('Could not check the repository: HTTP ' + existing.status);
  }

  const remote = 'https://github.com/' + owner + '/' + repoName + '.git';
  const runGit =
    run ||
    ((args, mode) =>
      execFileSync('git', args, {
        stdio: mode || 'inherit',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }));

  // Never echo the arguments: they contain the ephemeral Authorization header.
  const git = (args, mode) => {
    try {
      return runGit(args, mode);
    } catch (e) {
      if (run) throw e;
      const sub = args.find((a) => ['push', 'fetch', 'merge', 'rebase'].includes(a)) || 'command';
      const code = e.status != null ? e.status : '?';
      if (sub === 'push') {
        throw new Error(
          'git push was rejected (exit ' + code + '). The most common cause is that the remote ' +
            'already has commits. Merge them first:\n' +
            '  git fetch origin && git merge origin/main --allow-unrelated-histories\n' +
            'or re-run this script with --force to overwrite the remote branch.'
        );
      }
      throw new Error('git ' + sub + ' failed (exit ' + code + '). See the output above.');
    }
  };

  // Store a credential-free remote for normal use.
  try {
    git(['remote', 'get-url', 'origin'], 'ignore');
    git(['remote', 'remove', 'origin'], 'ignore');
  } catch {
    /* no existing remote */
  }
  git(['remote', 'add', 'origin', remote]);
  log('Remote: ' + remote);

  const auth = Buffer.from('x-access-token:' + token).toString('base64');
  log('Pushing main…');
  const pushArgs = [
    '-c',
    'http.sslBackend=openssl',
    '-c',
    'http.https://github.com/.extraheader=AUTHORIZATION: basic ' + auth,
    'push'
  ];
  if (opts.force) pushArgs.push('--force');
  pushArgs.push('-u', 'origin', 'HEAD:refs/heads/main');
  git(pushArgs);

  const head = await api(fetchImpl, '/repos/' + owner + '/' + repoName + '/commits?per_page=1', token);
  const sha = head.status === 200 && Array.isArray(head.data) && head.data[0] ? head.data[0].sha.slice(0, 7) : 'unknown';
  log('');
  log('Done: ' + remote.replace(/\.git$/, '') + '  (head ' + sha + ')');
  if (created) log('Tip: add a description/topics on GitHub, and the CI workflow will run on push.');

  return { owner, repo: repoName, remote, created, sha };
}

/* ------------------------------------------------------------------ */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }
  const envPath = args['env-file'] || join(ROOT, '.env.local');
  const file = readEnvFile(envPath);
  const opts = Object.assign({}, args, {
    token: args.token || file.GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',
    owner: args.owner || file.GITHUB_OWNER || process.env.GITHUB_OWNER || '',
    repo: args.repo || file.GITHUB_REPO || process.env.GITHUB_REPO || ''
  });
  if (Object.keys(file).length) console.log('Loaded credentials from ' + envPath);
  try {
    await push(opts, { log: console.log });
    process.exit(0);
  } catch (e) {
    console.error('\nERROR: ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
