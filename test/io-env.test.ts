// Copyright 2026 The agent-router-cc Authors
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutorEnv, buildWorkerEnv } from '../src/io/env.ts';

test('verification env stays minimal and excludes session/network secrets', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/test',
    LANG: 'C',
    SECURITYSESSIONID: 'session-1',
    HTTPS_PROXY: 'http://proxy.test:8080',
    AWS_SECRET_ACCESS_KEY: 'never-copy',
    ROUTER_TEST_API_KEY: 'explicit-only',
  };
  assert.deepEqual(buildWorkerEnv(source), {
    PATH: '/bin',
    HOME: '/home/test',
    LANG: 'C',
  });
  assert.equal(buildWorkerEnv(source, ['ROUTER_TEST_API_KEY']).ROUTER_TEST_API_KEY, 'explicit-only');
});

test('executor env preserves plan-auth session context and credential-free proxies', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/test',
    USER: 'tester',
    SECURITYSESSIONID: 'session-1',
    CLAUDE_CONFIG_DIR: '/config/claude',
    HTTPS_PROXY: 'http://proxy.test:8080',
    NO_PROXY: 'localhost,127.0.0.1',
    AWS_SECRET_ACCESS_KEY: 'never-copy',
    ROUTER_TEST_API_KEY: 'explicit-only',
  };
  const env = buildExecutorEnv(source, ['ROUTER_TEST_API_KEY']);
  assert.equal(env.SECURITYSESSIONID, 'session-1');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/config/claude');
  assert.equal(env.HTTPS_PROXY, 'http://proxy.test:8080');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(env.ROUTER_TEST_API_KEY, 'explicit-only');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test('executor env drops credential-bearing proxies unless explicitly opted in', () => {
  const source = {
    PATH: '/bin',
    HTTPS_PROXY: 'https://user:password@proxy.test:8443',
    http_proxy: 'user:password@proxy.test:8080',
  };
  assert.equal(buildExecutorEnv(source).HTTPS_PROXY, undefined);
  assert.equal(buildExecutorEnv(source).http_proxy, undefined);
  assert.equal(buildExecutorEnv(source, ['HTTPS_PROXY']).HTTPS_PROXY, source.HTTPS_PROXY);
});
