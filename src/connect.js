import { mkdir, open, rename, rm } from 'node:fs/promises';
import { PingRoom } from '@pingroom/sdk';
import { credentialsPath } from './config.js';

console.log('PingRoom lets this script ask you for approval on your phone.');
console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
const client = new PingRoom({ timeoutMs: 15_000 });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
try {
  const pairing = await client.auth.startPairing({ agent_label: 'Human review starter' });
  console.log(`Approve this connection: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: controller.signal });
  const room = (active.home_room ?? active.room)?.invite_code;
  if (!room) throw new Error('No delivery room was returned. Create a private room in PingRoom and reconnect.');
  const directory = new URL('../.pingroom/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = new URL(`credentials-${process.pid}.tmp`, directory);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify({ token: active.credential, room })}\n`);
    await file.close();
    file = undefined;
    await rename(temporary, credentialsPath);
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
  console.log('Connected. Credentials saved locally in ignored .pingroom/credentials.json (0600).');
  console.log('Run npm start to ask your first review question.');
} catch (error) {
  console.error(error.name === 'AbortError' ? 'Connection cancelled.' : `Connection failed: ${error.code ?? error.name}. ${error.message}`);
  process.exitCode = 1;
}
