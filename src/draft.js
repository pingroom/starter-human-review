import { mkdir, writeFile } from 'node:fs/promises';
import { validateProposal } from './review.js';

export const sampleProposal = Object.freeze({
  action: 'write_draft', filename: 'release-note.txt',
  content: 'The weekly report is ready for review. This is a local draft; nothing will be sent or published.',
});

/** Allowlisted sample handler: write a new local file; never overwrite a draft. */
export async function writeDraft(proposal) {
  const approved = validateProposal(proposal);
  const directory = new URL('../output/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const destination = new URL(approved.filename, directory);
  await writeFile(destination, approved.content, { flag: 'wx', mode: 0o600 });
  return destination.pathname;
}
