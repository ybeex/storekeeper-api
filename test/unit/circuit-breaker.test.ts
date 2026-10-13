import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, DependencyUnavailableError } from '../../src/lib/circuit-breaker.js';

const boom = () => Promise.reject(new Error('down'));
const ok = () => Promise.resolve('fine');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('opens after the failure threshold and then fails fast without calling the dependency', async () => {
  const b = new CircuitBreaker({ name: 't1', failureThreshold: 3, resetTimeoutMs: 50, callTimeoutMs: 100 });
  for (let i = 0; i < 3; i++) await assert.rejects(b.exec(boom), /down/);
  assert.equal(b.getState(), 'open');
  let called = false;
  await assert.rejects(b.exec(async () => { called = true; }), DependencyUnavailableError);
  assert.equal(called, false, 'an open breaker must not touch the dependency');
});

test('half-open admits one probe; success closes, failure re-opens', async () => {
  const b = new CircuitBreaker({ name: 't2', failureThreshold: 1, resetTimeoutMs: 30, callTimeoutMs: 100 });
  await assert.rejects(b.exec(boom));
  await sleep(40);
  assert.equal(b.getState(), 'half_open');
  assert.equal(await b.exec(ok), 'fine');
  assert.equal(b.getState(), 'closed');

  await assert.rejects(b.exec(boom));
  await sleep(40);
  await assert.rejects(b.exec(boom)); // failed probe
  assert.equal(b.getState(), 'open');
});

test('a hung call counts as a failure via the timeout', async () => {
  const b = new CircuitBreaker({ name: 't3', failureThreshold: 1, callTimeoutMs: 20 });
  await assert.rejects(b.exec(() => new Promise(() => {})), /timed out/);
  assert.equal(b.getState(), 'open');
});

test('errors the dependency itself answered (isFailure=false) do not trip the breaker', async () => {
  const b = new CircuitBreaker({ name: 't4', failureThreshold: 1, isFailure: () => false });
  await assert.rejects(b.exec(boom));
  assert.equal(b.getState(), 'closed');
});

test('execOr degrades to the fallback instead of throwing', async () => {
  const b = new CircuitBreaker({ name: 't5', failureThreshold: 1 });
  assert.equal(await b.execOr(boom, () => 'cached'), 'cached');
  assert.equal(await b.execOr(ok, () => 'cached'), 'cached'); // open → fallback
});
