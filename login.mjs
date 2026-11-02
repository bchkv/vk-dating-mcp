#!/usr/bin/env node
import {Session} from './session.mjs';
import {createInterface} from 'node:readline/promises';
const session=new Session();
const rl=createInterface({input:process.stdin,output:process.stdout});
try {
 await session.start({headless:false});
 await rl.question('Sign in to VK in the browser, open Dating, then press Enter here to save and close. ');
} finally {rl.close();await session.close();}
