import { test } from 'node:test';
import assert from 'node:assert/strict';
import FakeTimers from '@sinonjs/fake-timers';
import { GeminiBridge, BridgeTimeoutError } from '../geminiBridge';

test('enqueuePrompts adds jobs to a fresh workflowId', () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [
    { sceneIndex: 0, prompt: 'A stickman walks into a bar.' },
    { sceneIndex: 1, prompt: 'He orders a drink.' },
  ]);
  const result = bridge.poll('wf-1');
  assert.equal(result.status, 'running');
  assert.ok(result.job);
  assert.equal(result.job!.workflowId, 'wf-1');
  assert.equal(result.job!.sceneIndex, 0);
  assert.equal(result.job!.prompt, 'A stickman walks into a bar.');
});

test('enqueuePrompts is idempotent — re-enqueueing resets the queue', () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'old' }]);
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'new' }]);
  const result = bridge.poll('wf-1');
  assert.equal(result.job?.prompt, 'new');
});

test('postResult stores the buffer keyed by sceneIndex', async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [
    { sceneIndex: 0, prompt: 'A' },
    { sceneIndex: 1, prompt: 'B' },
  ]);
  const promise = bridge.awaitImages('wf-1', 2, 1000);
  bridge.postResult('wf-1', 0, Buffer.from('png-bytes-0'));
  bridge.postResult('wf-1', 1, Buffer.from('png-bytes-1'));
  const images = await promise;
  assert.equal(images.get(0)?.toString(), 'png-bytes-0');
  assert.equal(images.get(1)?.toString(), 'png-bytes-1');
});

test('cleanup removes all state for a workflowId', () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  assert.equal(bridge.getStatus('wf-1'), 'ready');
  bridge.cleanup('wf-1');
  assert.equal(bridge.getStatus('wf-1'), 'absent');
});

test('two workflows in parallel do not interfere', () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  bridge.enqueuePrompts('wf-2', [{ sceneIndex: 0, prompt: 'B' }]);
  const r1 = bridge.poll('wf-1');
  const r2 = bridge.poll('wf-2');
  assert.equal(r1.job?.prompt, 'A');
  assert.equal(r2.job?.prompt, 'B');
});

test("postResult is a no-op when workflow status is 'complete'", async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  const promise = bridge.awaitImages('wf-1', 1, 1000);
  bridge.postResult('wf-1', 0, Buffer.from('first'));
  const images = await promise;
  assert.equal(images.get(0)?.toString(), 'first');
  assert.equal(bridge.getStatus('wf-1'), 'complete');

  bridge.postResult('wf-1', 0, Buffer.from('late-duplicate'));

  const imagesAfter = await bridge.awaitImages('wf-1', 1, 1000);
  assert.equal(imagesAfter.get(0)?.toString(), 'first');
  assert.equal(bridge.getStatus('wf-1'), 'complete');
  assert.equal(bridge.getProgress('wf-1')?.received, 1);
});

test('cleanup rejects pending awaitImages with BridgeTimeoutError', async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [
    { sceneIndex: 0, prompt: 'A' },
    { sceneIndex: 1, prompt: 'B' },
  ]);
  const promise = bridge.awaitImages('wf-1', 2, 60_000);
  bridge.cleanup('wf-1');
  await assert.rejects(promise, BridgeTimeoutError);
  assert.equal(bridge.getStatus('wf-1'), 'absent');
});

test("recordSceneFailure is a no-op when workflow status is 'complete'", async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  const promise = bridge.awaitImages('wf-1', 1, 1000);
  bridge.postResult('wf-1', 0, Buffer.from('done'));
  await promise;
  assert.equal(bridge.getStatus('wf-1'), 'complete');

  bridge.recordSceneFailure('wf-1', 0);
  bridge.recordSceneFailure('wf-1', 0);
  bridge.recordSceneFailure('wf-1', 0);
  bridge.recordSceneFailure('wf-1', 0);

  assert.equal(bridge.getStatus('wf-1'), 'complete');
});

test('getReadiness returns ready:false when no extension has pinged', () => {
  const bridge = new GeminiBridge();
  const r = bridge.getReadiness();
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'no_extension');
});

test('getReadiness returns ready:true when extension pinged within 30s reporting ready', () => {
  const bridge = new GeminiBridge();
  bridge.recordPing(true);
  const r = bridge.getReadiness();
  assert.equal(r.ready, true);
});

test('getReadiness returns ready:false when last ping was >30s ago (liveness)', () => {
  const clock = FakeTimers.install({ now: 0 });
  try {
    const bridge = new GeminiBridge();
    bridge.recordPing(true);
    clock.tick(31_000);
    const r = bridge.getReadiness();
    assert.equal(r.ready, false);
    assert.equal(r.reason, 'no_extension');
  } finally {
    clock.uninstall();
  }
});

test('getReadiness surfaces the reason from the most recent ping', () => {
  const bridge = new GeminiBridge();
  bridge.recordPing(false, 'not_signed_in');
  const r = bridge.getReadiness();
  assert.equal(r.ready, false);
  assert.equal(r.reason, 'not_signed_in');
});

test('awaitImages rejects with BridgeTimeoutError if results never arrive', async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  await assert.rejects(
    () => bridge.awaitImages('wf-1', 1, 50),
    (err: Error) => err.name === 'BridgeTimeoutError'
  );
});

test('awaitImages rejects if a scene retry counter exceeds 3', async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  const promise = bridge.awaitImages('wf-1', 1, 1000);
  bridge.recordSceneFailure('wf-1', 0);
  bridge.recordSceneFailure('wf-1', 0);
  bridge.recordSceneFailure('wf-1', 0);
  await assert.rejects(
    () => promise,
    (err: Error) => err.name === 'BridgeSceneRetryExceededError'
  );
});

test("poll('discover') returns a job from any active workflow", () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  const r = bridge.poll('discover');
  assert.equal(r.status, 'running');
  assert.ok(r.job);
  assert.equal(r.job!.workflowId, 'wf-1');
});

test("poll('unknown_workflow') returns reason 'unknown_workflow'", () => {
  const bridge = new GeminiBridge();
  const r = bridge.poll('wf-nonexistent');
  assert.equal(r.status, 'running');
  assert.equal(r.reason, 'unknown_workflow');
});

test('recordSceneFailure with NaN sceneIndex does not crash', () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [{ sceneIndex: 0, prompt: 'A' }]);
  bridge.recordSceneFailure('wf-1', Number.NaN);
  assert.equal(bridge.getStatus('wf-1'), 'ready');
});
