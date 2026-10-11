import { describe, expect, it } from 'vitest';
import { parseGithubRepoUrl } from '../src/lib/githubUrl.js';

const repo = (fullName: string, refAndPath: string[] = []) => ({ fullName, refAndPath });

describe('parseGithubRepoUrl', () => {
  it.each([
    ['https://github.com/acme/orders', repo('acme/orders')],
    ['http://github.com/acme/orders', repo('acme/orders')],
    ['https://www.github.com/acme/orders/', repo('acme/orders')],
    ['https://github.com/acme/orders.git', repo('acme/orders')],
    ['github.com/acme/orders', repo('acme/orders')],
    ['  https://github.com/acme/orders  ', repo('acme/orders')],
    ['git@github.com:acme/orders.git', repo('acme/orders')],
    ['ssh://git@github.com/acme/orders.git', repo('acme/orders')],
    ['acme/orders', repo('acme/orders')],
    ['https://github.com/acme/orders?tab=readme#install', repo('acme/orders')],
    ['https://github.com/acme/orders/issues/12', repo('acme/orders')],
    ['https://github.com/acme/my.repo_name-2', repo('acme/my.repo_name-2')],
  ])('reads %s', (input, expected) => {
    expect(parseGithubRepoUrl(input)).toEqual(expected);
  });

  it('reads the branch and folder out of /tree/ links', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/orders/tree/main')).toEqual(repo('acme/orders', ['main']));
    expect(parseGithubRepoUrl('https://github.com/acme/orders/tree/main/infra/prod')).toEqual(repo('acme/orders', ['main', 'infra', 'prod']));
  });

  it('keeps a branch name with slashes as separate segments for the caller to resolve', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/orders/tree/feature/x/infra')).toEqual(repo('acme/orders', ['feature', 'x', 'infra']));
  });

  it('drops the file name from /blob/ links', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/orders/blob/main/infra/main.tf')).toEqual(repo('acme/orders', ['main', 'infra']));
  });

  it('decodes percent-encoded segments', () => {
    expect(parseGithubRepoUrl('https://github.com/acme/orders/tree/main/my%20folder')).toEqual(repo('acme/orders', ['main', 'my folder']));
  });

  it.each([
    '',
    '   ',
    'not a link',
    'https://gitlab.com/acme/orders',
    'https://github.com.evil.example/acme/orders',
    'https://evil.example/github.com/acme/orders',
    'example.com/orders',
    'https://github.com/acme',
    'https://github.com/',
    'https://github.com/-bad-/orders',
    'https://github.com/acme/..',
    'https://github.com/acme/orders/tree/main/../secrets',
    'git@gitlab.com:acme/orders.git',
    `https://github.com/acme/${'x'.repeat(600)}`,
  ])('refuses %j', (input) => {
    expect(parseGithubRepoUrl(input)).toBeNull();
  });
});
