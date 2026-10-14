import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createOfflineClient } from '../src/offline.js';
import { requestReview, reviewThenExecute, validateProposal } from '../src/review.js';

const proposal = { action: 'write_draft', filename: 'draft.txt', content: 'A draft to review.' };
const options = (client, extra = {}) => ({ client, room: 'DEMO', proposal: { ...proposal }, timeoutMs: 1000, ...extra });

test('only an exact affirmative answer executes the validated snapshot', async () => {
  const { client, calls } = createOfflineClient();
  let received;
  const result = await reviewThenExecute(options(client, { execute: async (value) => { received = value; return 'saved'; } }));
  assert.equal(result.executed, true);
  assert.equal(result.result, 'saved');
  assert.deepEqual(received, proposal);
  assert.ok(Object.isFrozen(received));
  assert.equal(calls[0].body.responder_scope, 'direct');
  assert.equal(calls[0].body.data.proposal_hash, result.proposalHash);
  assert.equal(calls[0].body.ttl, 30);
  assert.ok(calls[0].headers['Idempotency-Key'].length < 255);
});

for (const [state, answer] of [['answered', 'deny'], ['answered', 'APPROVE'], ['answered', null], ['expired', 'approve'], ['cancelled', 'approve']]) {
  test(`${state}/${answer} cannot execute`, async () => {
    const { client } = createOfflineClient({ state, answer });
    const result = await reviewThenExecute(options(client, { execute: () => assert.fail('unsafe execution') }));
    assert.equal(result.executed, false);
  });
}

for (const field of ['id', 'prompt', 'context', 'responder_scope', 'correlation_id', 'data', 'options']) {
  test(`rejects a mismatched returned ${field}`, async () => {
    const { client } = createOfflineClient({ onWait: (q) => ({ ...q, [field]: 'different' }) });
    await assert.rejects(reviewThenExecute(options(client, { execute: () => assert.fail('unsafe execution') })), { code: 'question_mismatch' });
  });
}

for (const phase of ['onCreate', 'onWait']) {
  for (const [description, changeOptions] of [
    ['swapped labels', (choices) => choices.map((choice, index) => ({ ...choice, label: choices[1 - index].label }))],
    ['missing approve label', (choices) => [{ value: choices[0].value }, choices[1]]],
    ['malformed deny label', (choices) => [choices[0], { ...choices[1], label: null }]],
  ]) {
    test(`rejects ${description} in ${phase} before execution`, async () => {
      const { client, calls } = createOfflineClient({
        [phase]: (question) => ({ ...question, options: changeOptions(question.options) }),
      });
      let executions = 0;
      const error = await reviewThenExecute(options(client, {
        execute: () => { executions += 1; },
      })).then(() => null, (reason) => reason);
      assert.equal(executions, 0, 'Mismatched visible choices must not execute.');
      assert.equal(error?.code, 'question_mismatch');
      if (phase === 'onCreate') assert.ok(!calls.some((call) => call.path.endsWith('/wait')));
    });
  }
}

test('an already-expired approval cannot execute', async () => {
  const { client } = createOfflineClient({ onWait: (q) => ({ ...q, expires_at: new Date(0).toISOString() }) });
  await assert.rejects(reviewThenExecute(options(client, { execute: () => assert.fail('unsafe execution') })), { code: 'expired_approval' });
});

test('an unexpected question state cannot execute', async () => {
  const { client } = createOfflineClient({ state: 'unknown' });
  await assert.rejects(reviewThenExecute(options(client, { execute: () => assert.fail('unsafe execution') })), { code: 'invalid_state' });
});

test('invalid or additional model fields are rejected before asking', async () => {
  const { client, calls } = createOfflineClient();
  for (const input of [null, { ...proposal, action: 'shell' }, { ...proposal, filename: '../secret.txt' }, { ...proposal, command: 'echo x' }, { ...proposal, content: 'a'.repeat(281) }]) {
    await assert.rejects(requestReview(options(client, { proposal: input })), { code: 'invalid_proposal' });
  }
  assert.equal(calls.length, 0);
});

test('caller mutations while waiting cannot change what executes', async () => {
  const original = { ...proposal };
  const { client } = createOfflineClient({ onWait: (q) => { original.content = 'Changed after review started'; return q; } });
  const outcome = await reviewThenExecute(options(client, {
    proposal: original,
    execute: (value) => {
      assert.equal(value.content, proposal.content);
      assert.throws(() => { value.content = 'not permitted'; }, TypeError);
    },
  }));
  assert.equal(outcome.executed, true);
});

test('each invocation creates a distinct review attempt for the same proposal', async () => {
  const { client, calls } = createOfflineClient();
  await requestReview(options(client));
  await requestReview(options(client));
  const creations = calls.filter((c) => c.body?.prompt);
  assert.notEqual(creations[0].headers['Idempotency-Key'], creations[1].headers['Idempotency-Key']);
  assert.equal(creations[0].body.data.proposal_hash, creations[1].body.data.proposal_hash);
});

test('deadline interrupts a pending wait and requests remote cancellation', async () => {
  const { client, calls } = createOfflineClient({ state: 'pending' });
  await assert.rejects(reviewThenExecute(options(client, { timeoutMs: 20, execute: () => assert.fail('unsafe execution') })), { code: 'timeout' });
  await nextTurn();
  assert.ok(calls.some((c) => c.path.endsWith('/cancel')));
});

test('cancelling a review interrupts the wait without executing', async () => {
  const controller = new AbortController();
  const { client, calls } = createOfflineClient({ onWait: (q) => { controller.abort(); return q; } });
  await assert.rejects(reviewThenExecute(options(client, { signal: controller.signal, execute: () => assert.fail('unsafe execution') })), { code: 'aborted' });
  await nextTurn();
  assert.ok(calls.some((c) => c.path.endsWith('/cancel')));
});

test('an already-aborted signal never asks a question', async () => {
  const { client, calls } = createOfflineClient();
  await assert.rejects(requestReview(options(client, { signal: AbortSignal.abort() })), { code: 'aborted' });
  assert.equal(calls.length, 0);
});

test('creation that finishes after the deadline is cancelled and cannot execute', async () => {
  let finish;
  const created = new Promise((resolve) => { finish = resolve; });
  const { client, calls } = createOfflineClient({ onCreate: async (q) => { await created; return q; } });
  await assert.rejects(reviewThenExecute(options(client, { timeoutMs: 20, execute: () => assert.fail('unsafe execution') })), { code: 'timeout' });
  finish();
  await nextTurn();
  assert.ok(calls.some((c) => c.path.endsWith('/cancel')));
  assert.ok(!calls.some((c) => c.path.endsWith('/wait')));
});

test('transport failure is surfaced; failure to cancel does not mask it', async () => {
  const { client } = createOfflineClient({ onWait: () => { throw new Error('transport unavailable'); } });
  client.questions.cancel = async () => { throw new Error('cancel also unavailable'); };
  await assert.rejects(reviewThenExecute(options(client, { execute: () => assert.fail('unsafe execution') })), /transport unavailable/);
  await nextTurn();
});

test('proposal maximum length keeps visible question under 500 characters', () => {
  const value = validateProposal({ action: 'write_draft', filename: `${'a'.repeat(50)}.txt`, content: '🕊'.repeat(280) });
  assert.ok([...`Write local draft output/${value.filename}?\n\n${value.content}`].length < 500);
});

test('trailing whitespace is trimmed, as the server trims the prompt it stores', () => {
  const value = validateProposal({ action: 'write_draft', filename: 'notes.txt', content: 'Ship the draft.\n\n' });
  assert.equal(value.content, 'Ship the draft.');
  assert.throws(() => validateProposal({ action: 'write_draft', filename: 'notes.txt', content: ' \n' }), /1–280/);
});

test('trailing invisible marks the server trims are trimmed too, so the stored prompt matches', async () => {
  // RLM, ZWSP and the soft hyphen survive JS trimEnd(), but Laravel's
  // TrimStrings drops them, so the server stores the prompt without them.
  const stored = 'Write local draft output/notes.txt?\n\nShip the draft.';
  const server = (question) => ({ ...question, prompt: stored });
  for (const tail of ['\u200F', '\u200B', '\u00AD']) {
    const { client, calls } = createOfflineClient({ onCreate: server, onWait: server });
    let written;
    const result = await reviewThenExecute({
      client, room: 'DEMO', timeoutMs: 1000,
      proposal: { action: 'write_draft', filename: 'notes.txt', content: `Ship the draft.${tail}` },
      execute: async (value) => { written = value.content; return 'saved'; },
    });
    assert.equal(result.executed, true, JSON.stringify(tail));
    assert.equal(written, 'Ship the draft.');
    assert.equal(calls[0].body.prompt, stored);
  }
  assert.throws(() => validateProposal({ action: 'write_draft', filename: 'notes.txt', content: '\u200B\u00AD' }), /1–280/);
});
