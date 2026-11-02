import {logEvent,logOutcome} from './event-log.mjs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {appFrame, inspect} from './adapter.mjs';
export const projectDir = dirname(fileURLToPath(import.meta.url));
export const profileDir = resolve(process.env.VK_DATING_PROFILE_DIR || resolve(projectDir, '.browser-profile'));
export class Session {
  idleTimer = null;
  idleTimeoutMs = 180000;
  context = null;
  page = null;
  async start({headless=true} = {}) {
    if (this.context && this.page && !this.page.isClosed()) {await logEvent('browser.reused',{reused:true});return {started:true,reused:true,profileDir};}
    await this.close();
    const {chromium} = await import('playwright');
    // Default headless Chromium uses Playwright Headless Shell, not regular Chrome.
    await mkdir(profileDir, {recursive:true,mode:0o700});
    try {
      await logEvent('browser.start.attempted',{});
      this.context = await chromium.launchPersistentContext(profileDir, {headless, viewport:{width:1280,height:900}});
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      await this.page.goto('https://vk.ru/dating', {waitUntil:'domcontentloaded'});
      await logOutcome('browser.start.completed',{outcome:'success'});
      return {started:true, profileDir, instruction:'Sign in manually only if requested by VK. Login persists in this profile.'};
    } catch(error) {
      await logOutcome('browser.start.failed',{errorType:error.name,outcome:'failure'});
      await this.close();
      throw new Error(`Headless Shell could not start. Install it with: node node_modules/playwright/cli.js install --only-shell chromium. Also check the dedicated VK profile lock. ${error.message}`);
    }
  }
  async frame() {
    if (!this.context || !this.page || this.page.isClosed()) throw new Error('Call vk_start first.');
    return appFrame(this.page);
  }
  async status() {
    if (!this.page || this.page.isClosed()) return {running:false,profileDir};
    let appReady=false;
    try { await appFrame(this.page,1000); appReady=true; } catch {}
    return {running:true,appReady,profileDir,url:this.page.url(),authentication:appReady?'app_loaded':'unknown'};
  }
  async capture() {
    const frame=await this.frame();
    const dir=resolve(projectDir,'captures',new Date().toISOString().replace(/[:.]/g,'-'));
    await mkdir(dir,{recursive:true,mode:0o700});
    await writeFile(resolve(dir,'frame.html'),await frame.content(),{mode:0o600});
    await writeFile(resolve(dir,'aria.yml'),await frame.locator('body').ariaSnapshot(),{mode:0o600});
    await writeFile(resolve(dir,'inspection.json'),JSON.stringify(await inspect(frame),null,2),{mode:0o600});
    return {directory:dir,files:['frame.html','aria.yml','inspection.json']};
  }
  cancelIdleClose() {
    if(this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer=null;
  }
  armIdleClose() {
    this.cancelIdleClose();
    this.idleTimer=setTimeout(async()=>{
      this.idleTimer=null;
      try {
        if(this.page&&!this.page.isClosed()) {
          const frame=await this.frame();
          const editors=frame.locator('#chat:visible textarea[data-testid="write-bar"]');
          for(let i=0;i<await editors.count();i++) if(await editors.nth(i).inputValue()) {this.armIdleClose();return;}
        }
      } catch {}
      await logOutcome('browser.idle_timeout',{});
      await this.close().catch(()=>{});
    },this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
  async close() {
    this.cancelIdleClose();
    const context=this.context;this.context=null;this.page=null;
    if(context) {
      await logOutcome('browser.close.attempted',{});
      try{await context.close();await logOutcome('browser.close.completed',{closed:true,outcome:'success'});}
      catch(error){await logOutcome('browser.close.failed',{errorType:error.name,outcome:'failure'});throw error;}
    }
    return {closed:true,cookiesPreserved:true};
  }
}
