import { PingRoom } from '@pingroom/sdk';
import { loadConfig } from './config.js';
import { reviewThenExecute } from './review.js';
import { sampleProposal, writeDraft } from './draft.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  try { process.loadEnvFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { token, room } = await loadConfig();
  const client = new PingRoom({ token, timeoutMs: 15_000 });
  console.log(`Requesting approval to create output/${sampleProposal.filename}. Tap Approve or Deny in PingRoom.`);
  const outcome = await reviewThenExecute({ client, room, proposal: sampleProposal, signal: controller.signal, execute: writeDraft });
  console.log(outcome.executed ? `Draft written: ${outcome.result}` : `No draft written (${outcome.state}: ${outcome.answer ?? 'no answer'}).`);
  if (!outcome.executed) process.exitCode = 2;
} catch (error) {
  console.error(`Review stopped: ${error.code ?? error.name}. ${error.message}`);
  process.exitCode = 1;
}
