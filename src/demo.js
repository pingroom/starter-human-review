import { randomUUID } from 'node:crypto';
import { createOfflineClient } from './offline.js';
import { reviewThenExecute } from './review.js';
import { sampleProposal, writeDraft } from './draft.js';

console.log('Offline demo: the real SDK uses an in-memory transport with a simulated human answer.');
for (const answer of ['deny', 'approve']) {
  const { client } = createOfflineClient({ answer });
  const proposal = { ...sampleProposal, filename: `demo-${randomUUID()}.txt` };
  const result = await reviewThenExecute({ client, room: 'DEMO', proposal, execute: writeDraft });
  console.log(`${answer}: ${result.executed ? `wrote ${result.result}` : 'execution skipped'}`);
}
