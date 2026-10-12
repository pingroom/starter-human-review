import { readFile } from 'node:fs/promises';

export const credentialsPath = new URL('../.pingroom/credentials.json', import.meta.url);

function validatePair(token, room) {
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !room.trim()) {
    throw new Error('Provide both PINGROOM_TOKEN and PINGROOM_ROOM, or run npm run connect.');
  }
  return { token: token.trim(), room: room.trim() };
}

export async function loadConfig(env = process.env, path = credentialsPath) {
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    return validatePair(env.PINGROOM_TOKEN, env.PINGROOM_ROOM);
  }
  let saved;
  try { saved = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Run npm run connect, or provide PINGROOM_TOKEN and PINGROOM_ROOM.');
    throw new Error('Cannot read .pingroom/credentials.json. Reconnect with npm run connect.');
  }
  return validatePair(saved?.token, saved?.room);
}
