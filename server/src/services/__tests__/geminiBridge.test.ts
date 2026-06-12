import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiBridge } from '../geminiBridge';

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
  const { images, partial } = await promise;
  assert.equal(partial, false);
  assert.equal(images.get(0)?.toString(), 'png-bytes-0');
  assert.equal(images.get(1)?.toString(), 'png-bytes-1');
});

test('awaitImages returns partial results on timeout', async () => {
  const bridge = new GeminiBridge();
  bridge.enqueuePrompts('wf-1', [
    { sceneIndex: 0, prompt: 'A' },
    { sceneIndex: 1, prompt: 'B' },
    { sceneIndex: 2, prompt: 'C' },
  ]);
  // Post only 2 of 3 images, then await with very short timeout
  bridge.postResult('wf-1', 0, Buffer.from('img-0'));
  bridge.postResult('wf-1', 1, Buffer.from('img-1'));
  const { images, partial } = await bridge.awaitImages('wf-1', 3, 100);
  assert.equal(partial, true);
  assert.equal(images.size, 2);
  assert.equal(images.get(0)?.toString(), 'img-0');
  assert.equal(images.get(1)?.toString(), 'img-1');
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
