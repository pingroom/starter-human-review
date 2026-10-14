import { createHash, randomUUID } from 'node:crypto';

export class ReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReviewError';
    this.code = code;
  }
}

// What Laravel's TrimStrings middleware (Str::trim) strips from both ends of every string the server stores.
const serverTrimmable = /^[\s\0\u0085\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2060-\u2065\u206A-\u206F\u2800\u3164\uFFA0\u{1D159}\u{1D173}-\u{1D17A}\u{E0020}]$/u;

/** Trim the end as the server does. JS trimEnd() keeps ZWSP, LRM/RLM, the soft hyphen, and other invisible marks. */
function serverTrimEnd(value) {
  const characters = [...value];
  let end = characters.length;
  while (end > 0 && serverTrimmable.test(characters[end - 1])) end -= 1;
  return characters.slice(0, end).join('');
}

/** Validate the allowlisted action and detach it from mutable model/caller output. */
export function validateProposal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'action,content,filename'
    || input.action !== 'write_draft'
    || typeof input.filename !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}\.txt$/.test(input.filename)
    || typeof input.content !== 'string'
    || input.content.length < 1 || [...input.content].length > 280
    || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(input.content)) {
    throw new ReviewError('invalid_proposal', 'Expected write_draft, a safe .txt filename, and 1–280 characters of text.');
  }
  // The content ends the question's prompt, and the server trims the ends of
  // every string it stores. Trim it the same way here so the prompt it echoes
  // back matches, and the draft written is the text that was shown.
  const content = serverTrimEnd(input.content);
  if (content.length < 1) {
    throw new ReviewError('invalid_proposal', 'Expected write_draft, a safe .txt filename, and 1–280 characters of text.');
  }
  return Object.freeze({ action: input.action, filename: input.filename, content });
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function assertQuestion(question, expected, id) {
  if (!question || typeof question.id !== 'string' || question.id.length === 0
    || (id !== undefined && question.id !== id)
    || question.prompt !== expected.prompt || question.context !== expected.context
    || question.responder_scope !== 'direct'
    || question.correlation_id !== expected.correlation_id
    || question.data?.proposal_hash !== expected.data.proposal_hash
    || !Array.isArray(question.options)
    || question.options.length !== expected.options.length
    || expected.options.some((option, index) => question.options[index]?.value !== option.value
      || question.options[index]?.label !== option.label)) {
    throw new ReviewError('question_mismatch', 'The returned question does not match this proposal and review attempt.');
  }
}

/** Ask the connected human. Non-affirmative terminal states are normal outcomes. */
export async function requestReview({ client, room, proposal, timeoutMs = 120_000, signal }) {
  const snapshot = validateProposal(proposal);
  if (typeof room !== 'string' || room.trim() === '') throw new ReviewError('invalid_room', 'Provide a PingRoom room code.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new ReviewError('invalid_timeout', 'timeoutMs must be an integer between 1 and 86400000.');
  }
  const proposalHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const attempt = randomUUID();
  const input = {
    prompt: `Write local draft output/${snapshot.filename}?\n\n${snapshot.content}`,
    context: `Draft ${proposalHash.slice(0, 16)}`,
    options: [
      { value: 'approve', label: 'Approve', style: 'primary' },
      { value: 'deny', label: 'Deny', style: 'danger' },
    ],
    responder_scope: 'direct',
    ttl: Math.max(30, Math.ceil(timeoutMs / 1000)),
    idempotencyKey: `review-${attempt}-${proposalHash}`,
    correlation_id: `review-${attempt}`,
    data: { proposal_hash: proposalHash },
  };
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const abort = () => controller.abort(new ReviewError('aborted', 'Review cancelled locally.'));
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new ReviewError('timeout', 'No approval arrived before the local deadline.')), timeoutMs);
  let questionId;
  let cancelRequested = false;
  // The SDK create call cannot take a signal. A late successful create must also
  // be withdrawn. Cancellation is best effort; TTL is the fallback after exit.
  const cancel = (id) => {
    if (!id || cancelRequested) return;
    cancelRequested = true;
    Promise.resolve().then(() => client.questions.cancel(id)).catch(() => {});
  };
  try {
    controller.signal.throwIfAborted();
    const creation = Promise.resolve().then(() => client.questions.ask(room, input));
    creation.then((question) => {
      if (controller.signal.aborted && typeof question?.id === 'string') cancel(question.id);
    }, () => {});
    const created = await abortable(creation, controller.signal);
    questionId = created?.id;
    assertQuestion(created, input);
    const result = await abortable(
      Promise.resolve().then(() => client.questions.waitForAnswer(questionId, { signal: controller.signal })),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new ReviewError('timeout', 'No approval arrived before the local deadline.');
    assertQuestion(result, input, questionId);
    if (!['answered', 'expired', 'cancelled'].includes(result.state)) {
      throw new ReviewError('invalid_state', 'The question did not return a terminal state.');
    }
    const approved = result.state === 'answered' && result.answer?.value === 'approve';
    if (approved && (!Number.isFinite(Date.parse(result.expires_at)) || Date.parse(result.expires_at) <= Date.now())) {
      throw new ReviewError('expired_approval', 'The approval is already expired or has no valid expiry.');
    }
    return Object.freeze({
      approved, state: result.state, answer: result.answer?.value ?? null,
      questionId, proposalHash, proposal: snapshot,
      validUntil: Math.min(deadline, Date.parse(result.expires_at)),
    });
  } catch (error) {
    cancel(questionId);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** The only path to execution is an exact, matching, unexpired approval. */
export async function reviewThenExecute({ execute, ...options }) {
  if (typeof execute !== 'function') throw new TypeError('execute must be a function.');
  const review = await requestReview(options);
  if (options.signal?.aborted) throw new ReviewError('aborted', 'Cancelled before execution.');
  if (!review.approved) return { ...review, executed: false };
  if (Date.now() >= review.validUntil) throw new ReviewError('expired_approval', 'Approval expired before execution.');
  const result = await execute(review.proposal, { questionId: review.questionId, proposalHash: review.proposalHash });
  return { ...review, executed: true, result };
}
