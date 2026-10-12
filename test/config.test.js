import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

test('a complete environment pair works without reading malformed local credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, 'not json');
  assert.deepEqual(await loadConfig({ PINGROOM_TOKEN: ' env-token ', PINGROOM_ROOM: ' NEWROOM ' }, path), { token: 'env-token', room: 'NEWROOM' });
});

test('a partial or blank environment pair never borrows saved values', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, JSON.stringify({ token: 'saved-token', room: 'SAVED' }));
  for (const env of [{ PINGROOM_TOKEN: 'new-token' }, { PINGROOM_ROOM: 'NEWROOM' }, { PINGROOM_TOKEN: ' ', PINGROOM_ROOM: 'NEWROOM' }]) {
    await assert.rejects(loadConfig(env, path), /Provide both/);
  }
  assert.deepEqual(await loadConfig({}, path), { token: 'saved-token', room: 'SAVED' });
});

test('missing, malformed, and invalid saved credentials fail with actionable errors', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await assert.rejects(loadConfig({}, path), /npm run connect/);
  await writeFile(path, 'not json');
  await assert.rejects(loadConfig({}, path), /Cannot read/);
  await writeFile(path, JSON.stringify({ token: 123, room: 'ROOM' }));
  await assert.rejects(loadConfig({}, path), /Provide both/);
});
