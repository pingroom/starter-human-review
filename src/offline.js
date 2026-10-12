import { PingRoom } from '@pingroom/sdk';

/** Real SDK, in-memory HTTP transport. No network or credentials are used. */
export function createOfflineClient({ state = 'answered', answer = 'approve', onCreate, onWait } = {}) {
  let question;
  const calls = [];
  const fetch = async (url, init) => {
    const target = new URL(url);
    if (target.origin !== 'https://review-demo.invalid') throw new Error('Unexpected offline origin.');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: target.pathname, body, headers: init.headers });
    let response;
    if (init.method === 'POST' && /^\/api\/agent\/rooms\/[^/]+\/questions$/.test(target.pathname)) {
      question = {
        ...body, id: 'offline-question', kind: 'question', state: 'pending', answer: null,
        expires_at: new Date(Date.now() + body.ttl * 1000).toISOString(),
      };
      response = onCreate ? await onCreate(structuredClone(question), init.signal) : question;
    } else if (init.method === 'GET' && target.pathname === '/api/agent/questions/offline-question/wait') {
      response = { ...question, state, answer: state === 'answered' ? { value: answer } : null };
      if (onWait) response = await onWait(structuredClone(response), init.signal);
    } else if (init.method === 'POST' && target.pathname === '/api/agent/questions/offline-question/cancel') {
      response = { ...question, state: 'cancelled', answer: null };
    } else {
      throw new Error(`Unexpected offline API request: ${init.method} ${target.pathname}`);
    }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
  return { client: new PingRoom({ token: 'offline-demo-token', baseUrl: 'https://review-demo.invalid', fetch }), calls };
}
