/**
 * A fake isomorphic-git HTTP transport that serves local repositories through
 * `git upload-pack`, so tests exercise the real clone/fetch protocol with no
 * network. (Fixture repos are still *built* with the git CLI; the code under
 * test never shells out.)
 *
 * URLs look like `https://git.test/<absolute repo path>[.git]`.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import type { HttpClient as GitHttpClient } from 'isomorphic-git';

export const LOCAL_GIT_HOST = 'https://git.test';

/** The URL under which `repoDir` is served by `localGitHttp`. */
export function localGitUrl(repoDir: string): string {
  return `${LOCAL_GIT_HOST}${repoDir}`;
}

async function collect(body: AsyncIterable<Uint8Array> | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (body) for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function respond(url: string, method: string, statusCode: number, contentType: string, data: Buffer) {
  return {
    url,
    method,
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'Not Found',
    headers: { 'content-type': contentType },
    body: (async function* () { yield new Uint8Array(data); })(),
  };
}

export const localGitHttp: GitHttpClient = {
  async request({ url, method = 'GET', body }) {
    const { pathname } = new URL(url);
    // `githubCloneUrl` appends `.git`, and fixture dirs may or may not carry it — accept either.
    const base = pathname.replace(/\/(info\/refs|git-upload-pack)$/, '');
    const repoDir = [base, base.replace(/\.git$/, ''), `${base}.git`].find(d => fs.existsSync(d)) ?? base;
    if (method === 'GET') {
      const r = spawnSync('git', ['upload-pack', '--stateless-rpc', '--advertise-refs', repoDir]);
      if (r.status !== 0) return respond(url, method, 404, 'text/plain', Buffer.from(String(r.stderr)));
      const head = Buffer.from('001e# service=git-upload-pack\n0000');
      return respond(url, method, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat([head, r.stdout]));
    }
    const r = spawnSync('git', ['upload-pack', '--stateless-rpc', repoDir], { input: await collect(body), maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) return respond(url, method, 404, 'text/plain', Buffer.from(String(r.stderr)));
    return respond(url, method, 200, 'application/x-git-upload-pack-result', r.stdout);
  },
};
