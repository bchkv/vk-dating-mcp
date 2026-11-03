import {existsSync} from 'node:fs';
import {AuthenticationRequiredError,isAuthenticationPage} from './authentication.mjs';
import {logEvent,logOutcome} from './event-log.mjs';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {appFrame, inspect} from './adapter.mjs';
import {observePage,captureFailure} from './diagnostics.mjs';
import {ActivityGuard,ActivityPausedError,detectSecurityPage} from './activity-guard.mjs';
export const projectDir = dirname(fileURLToPath(import.meta.url));
export const profileDir = resolve(process.env.VK_DATING_PROFILE_DIR || resolve(projectDir, '.browser-profile'));
export class Session {
  idleTimer = null;
  idleTimeoutMs = 0; // Keep the authenticated session until explicitly closed or the server exits.
  guard = new ActivityGuard(resolve(projectDir,'data'));
  async checkSecurity(){
    if(!this.page||this.page.isClosed())return;
    const incident=await detectSecurityPage(this.page);
    if(incident){const state=this.guard.pause(incident.reason);throw new ActivityPausedError('VK presented a security check. Activity stopped until manually resolved and resumed.',state);}
  }
  findAppFrame = appFrame;
  authPending = false;
  headless = true;
  network = {requestFailures:[],httpErrors:[],pageErrors:[]};
  context = null;
  page = null;
  async start({headless=true} = {}) {
    this.guard.assertAllowed();
    await this.checkSecurity();
    if (this.context && this.page && !this.page.isClosed()) {
      if(this.authPending){
        if(await isAuthenticationPage(this.page))return {started:true,authentication:'required',visible:true};
        // Successful sign-in may leave the visible browser on VK's home page.
        // Resume only landing-page navigation; never replay the interrupted action.
        try {
          await this.page.goto('https://vk.ru/dating',{waitUntil:'domcontentloaded',timeout:30000});
          await this.findAppFrame(this.page,15000);
        } catch {return {started:true,authentication:'required',visible:true};}
        this.authPending=false;
        return {started:true,reused:true,visible:!this.headless,authentication:'app_loaded'};
      }
      await logEvent('browser.reused',{reused:true});return {started:true,reused:true,profileDir};
    }
    await this.close();
    const {chromium} = await import('playwright');
    // Use the installed Chrome binary consistently for visible and headless sessions.
    await mkdir(profileDir, {recursive:true,mode:0o700});
    try {
      await logEvent('browser.start.attempted',{});
      this.headless=headless;
      const options={channel:'chrome',headless,viewport:{width:1280,height:900}};
      // Keep browser identity and persistent cookies consistent during manual login.
      // Use the same installed browser in both modes; never switch to Headless Shell.
      this.context = await chromium.launchPersistentContext(profileDir, options);
      this.page = this.context.pages()[0] ?? await this.context.newPage();
      this.network=observePage(this.page);
      await this.page.goto('https://vk.ru/dating', {waitUntil:'domcontentloaded',timeout:30000});
      await this.checkSecurity();
      await logOutcome('browser.start.completed',{outcome:'success'});
      return {started:true, profileDir, instruction:'Sign in manually only if requested by VK. Login persists in this profile.'};
    } catch(error) {
      if(error.name==='ActivityPausedError'){await this.close();throw error;}
      const diagnostics=this.page?await this.diagnose('navigation'):null;
      await logOutcome('browser.start.failed',{errorType:error.name,outcome:'failure'});
      await this.close();
      const failure=new Error(`${headless?'Headless browser':'Visible sign-in browser'} could not start. Install it with: node node_modules/playwright/cli.js install --only-shell chromium. Also check the dedicated VK profile lock. ${error.message}`);
      if(diagnostics)failure.diagnostics=diagnostics;
      throw failure;
    }
  }
  async frame() {
    this.guard.assertAllowed();
    await this.checkSecurity();
    if (!this.context || !this.page || this.page.isClosed()) throw new Error('Call vk_start first.');
    if(this.authPending)throw new AuthenticationRequiredError();
    try {return await this.findAppFrame(this.page);} catch(error){
      await this.checkSecurity();
      const authenticationRequired=await isAuthenticationPage(this.page);
      const diagnostics=await this.diagnose('app_detection',authenticationRequired);
      if(authenticationRequired){
        try{return await this.requireAuthentication();}catch(authError){if(diagnostics)authError.diagnostics=diagnostics;throw authError;}
      }
      const failure=new Error(diagnostics?`VK Dating not ready: ${diagnostics.classification}. ${diagnostics.nextStep} Diagnostics: ${diagnostics.directory}`:'VK Dating not ready; diagnostic capture also failed.');
      if(diagnostics)failure.diagnostics=diagnostics;
      throw failure;
    }
  }
  async diagnose(stage,authenticationRequired=false) {
    try{return await captureFailure(this.page,this.network,resolve(process.env.VK_DATING_DIAGNOSTICS_DIR||resolve(projectDir,'diagnostics')),{stage,authenticationRequired});}
    catch{return null;}
  }
  async login() {
    this.guard.assertAllowed();
    this.cancelIdleClose();
    if(this.context&&this.page&&!this.page.isClosed()&&!this.headless){
      this.authPending=true;
      await this.page.bringToFront();
      return {authentication:'manual',visible:true,reused:true,openedChats:0,instruction:'Complete sign-in in the VK window, then ask to check your inbox. No Terminal command is needed.'};
    }
    if(this.page&&!this.page.isClosed()){
      const editors=this.page.locator('textarea[data-testid="write-bar"]');
      for(let i=0;i<await editors.count();i++)if(await editors.nth(i).inputValue())throw Error('An unfinished message draft is open. Finish or discard it before switching browser mode.');
    }
    await this.close();
    try {await this.start({headless:false});}
    catch(error){throw new AuthenticationRequiredError(`The visible VK sign-in window could not open: ${error.message}`);}
    this.authPending=true;
    this.cancelIdleClose();
    await this.page.bringToFront();
    return {authentication:'manual',visible:true,reused:false,openedChats:0,instruction:'Complete sign-in in the VK window, then ask to check your inbox. No Terminal command is needed.'};
  }
  async requireAuthentication() {
    if(!this.authPending){
      await logOutcome('browser.authentication_required',{});
      await this.login();
    }
    throw new AuthenticationRequiredError();
  }
  async status() {
    if (!this.page || this.page.isClosed()) return {running:false,profileDir};
    let appReady=false;
    try { await this.findAppFrame(this.page,1000); appReady=true; } catch {}
    return {running:true,appReady,profileDir,url:this.page.url(),authentication:appReady?'app_loaded':this.authPending?'required':'unknown',visible:!this.headless};
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
    if(this.idleTimeoutMs===0)return;
    if(this.authPending)return; // Leave manual authentication open until completed or explicitly closed.
    this.idleTimer=setTimeout(async()=>{
      this.idleTimer=null;
      try {
        if(this.page&&!this.page.isClosed()) {
          const frame=await this.findAppFrame(this.page,1000);
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
    const context=this.context;this.context=null;this.page=null;this.authPending=false;
    if(context) {
      await logOutcome('browser.close.attempted',{});
      try{await context.close();await logOutcome('browser.close.completed',{closed:true,outcome:'success'});}
      catch(error){await logOutcome('browser.close.failed',{errorType:error.name,outcome:'failure'});throw error;}
    }
    return {closed:true,cookiesPreserved:true};
  }
}
