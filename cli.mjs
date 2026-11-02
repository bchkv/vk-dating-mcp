#!/usr/bin/env node
import {Session, projectDir} from './session.mjs';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {stdin, stdout} from 'node:process';
import {appFrame, inspect, navigate, openChat, react} from './adapter.mjs';
const help = `Commands:
  inspect                  Read tabs, chat rows, controls, and editors
  profiles | chats         Navigate to a tab
  open USER_ID             Open an existing chat (may mark messages read)
  like | dislike           Dry run: check for one visible matching control
  like --execute           Click once; server acceptance remains unverified
  dislike --execute        Click once; never auto-retried
  capture                  Save iframe HTML, ARIA, and inspection JSON locally
  help | quit
No sending messages, automatic swiping, or model API calls are implemented.`;
const session = new Session();
await session.start();
const rl = createInterface({input: stdin, output: stdout});
try {
  const page = session.page;
  console.log('Sign in manually in this dedicated Chrome profile. Your everyday profile is separate.');
  await rl.question('When the app is ready, press Enter here. ');
  console.log(help);
  for (;;) {
    const line = (await rl.question('vk> ')).trim();
    if (line === 'quit') break;
    if (!line || line === 'help') { console.log(help); continue; }
    try {
      const frame = await appFrame(page);
      const [cmd, arg, ...rest] = line.split(/\s+/);
      if (rest.length) throw new Error('Unexpected arguments');
      if (cmd === 'inspect' && !arg) console.log(JSON.stringify(await inspect(frame), null, 2));
      else if (['profiles', 'chats'].includes(cmd) && !arg) {
        await navigate(frame, cmd === 'profiles' ? '/' : '/chats');
        console.log(JSON.stringify(await inspect(frame), null, 2));
      } else if (cmd === 'open' && arg) console.log(await openChat(frame, arg));
      else if (['like', 'dislike'].includes(cmd) && (!arg || arg === '--execute')) console.log(await react(frame, cmd, arg === '--execute'));
      else if (cmd === 'capture' && !arg) {
        const dir = resolve(projectDir, 'captures', new Date().toISOString().replace(/[:.]/g, '-'));
        await mkdir(dir, {recursive: true, mode: 0o700});
        await writeFile(resolve(dir, 'frame.html'), await frame.content(), {mode: 0o600});
        await writeFile(resolve(dir, 'aria.yml'), await frame.locator('body').ariaSnapshot(), {mode: 0o600});
        await writeFile(resolve(dir, 'inspection.json'), JSON.stringify(await inspect(frame), null, 2), {mode: 0o600});
        console.log(`Saved ${dir}. Review captures for personal data before sharing.`);
      } else throw new Error('Unknown command or invalid arguments; type help');
    } catch (error) { console.error(error.message); }
  }
} finally { rl.close(); await session.close(); }
