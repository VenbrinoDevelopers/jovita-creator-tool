import { BadGatewayException } from '@nestjs/common';
import puppeteer, { type Page, type Browser } from 'puppeteer-core';
import axe from 'axe-core';
import type { HostingControlPlaneConfig, JsonObject } from './jovita-hosting.types.js';

const WIDTHS = [320, 390, 768, 1440];
const MAX_CONTROLS = 60;

/** Remote browser only. The caller must authorize the immutable release first. */
export async function auditBrowserQuality(config: HostingControlPlaneConfig, authorizedUrl: URL, identity: { site_id: string; release_id: string; manifest_hash: string } | { preview_id: string; revision: string }, signal?: AbortSignal, requestedChecks?: unknown, supportsInconclusive = false): Promise<JsonObject> {
  const checks = parseInteractionChecks(requestedChecks);
  signal?.throwIfAborted();
  const started = Date.now();
  let phase = 'connect';
  let viewport: number | undefined;
  let browser: Browser | undefined;
  let deadlineExpired = false;
  const activeStages = new Map<number,string>();
  let stop: ((error: Error) => void) | undefined;
  const cancelled = new Promise<never>((_,reject)=>{stop=reject;});
  // The rejection is raced with connection setup and consumed even if setup already completed.
  void cancelled.catch(()=>{});
  const abort = () => { stop?.(new Error('Browser audit stopped')); void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => { deadlineExpired = true; abort(); }, 120_000);
  const findings: JsonObject[] = [], coverage: JsonObject[] = [], metrics: JsonObject[] = [];
  try {
    const operation = (async () => {
    const connecting = puppeteer.connect({
      browserWSEndpoint: `wss://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/browser-rendering/devtools/browser`,
      headers: { Authorization: `Bearer ${config.cloudflareApiToken}` },
      protocolTimeout: 20_000,
    });
    void connecting.then(connected=>{if(deadlineExpired || signal?.aborted)void connected.close().catch(()=>{});},()=>{});
    browser = await Promise.race([connecting,cancelled]);
    signal?.throwIfAborted();
    if (deadlineExpired) throw new Error('audit deadline');
    phase = 'context';
    const context = await browser.createBrowserContext();
    // Independent viewports share one billed browser; remote CDP round trips overlap.
    await Promise.all(WIDTHS.map(async (width) => {
      let phase = 'page_setup';
      const setPhase=(value:string)=>{phase=value;activeStages.set(width,value);};
      setPhase('page_setup');
      let page: Page | undefined;
      try {
      signal?.throwIfAborted();
      const viewportContext = width===320 ? context : await browser!.createBrowserContext();
      page = await viewportContext.newPage();
      let formFixture: 'success' | 'error' | undefined;
      try {
        page.on('pageerror', () => findings.push({width,code:'BROWSER_RUNTIME_ERROR',severity:'major',evidence:'An uncaught page exception occurred. Inspect the page console in the private preview.'}));
        await page.setViewport({width,height:900,deviceScaleFactor:1});
        await page.setRequestInterception(true);
        page.on('request', request => {
          let url: URL;
          try { url = new URL(request.url()); } catch { void request.abort().catch(() => {}); return; }
          if (formFixture && request.method() === 'POST' && url.origin === authorizedUrl.origin && /^\/__jovita\/forms\/[a-f0-9-]{8,}$/.test(url.pathname)) {
            // Match the managed form endpoint's real 303 contract, including
            // query flags. Never manufacture a JSON success that production lacks.
            const target = fixtureFormRedirect(authorizedUrl, formFixture);
            void request.respond({status:303,headers:{location:target.href}}).catch(()=>{});
            return;
          }
          // Generated sites are static and local. Never submit leads or follow external requests.
          const fixtureReturn = formFixture && url.origin === authorizedUrl.origin && url.pathname === authorizedUrl.pathname && url.search === fixtureFormRedirect(authorizedUrl, formFixture).search;
          const allowed = request.method() === 'GET' && (fixtureReturn || !['xhr','fetch','eventsource','websocket','ping'].includes(request.resourceType())) && (!request.isNavigationRequest() || (url.origin === authorizedUrl.origin && url.pathname === authorizedUrl.pathname && (url.search === authorizedUrl.search || fixtureReturn))) && (url.origin === authorizedUrl.origin || ['data:','blob:'].includes(url.protocol));
          void (allowed ? request.continue() : request.abort()).catch(() => {});
        });
        await page.evaluateOnNewDocument(() => {
          const state = {lcp:null as number|null,cls:0};
          Object.defineProperty(window,'__jovitaLab',{value:state});
          try { new PerformanceObserver(list => { for(const entry of list.getEntries())state.lcp=entry.startTime; }).observe({type:'largest-contentful-paint',buffered:true}); } catch {}
          try { new PerformanceObserver(list => { for(const entry of list.getEntries() as Array<PerformanceEntry & {hadRecentInput?:boolean;value:number}>)if(!entry.hadRecentInput)state.cls+=entry.value; }).observe({type:'layout-shift',buffered:true}); } catch {}
        });
        setPhase('navigation');
        const response = await page.goto(authorizedUrl.href,{waitUntil:'load',timeout:25_000});
        if (!response?.ok() || new URL(page.url()).origin !== authorizedUrl.origin) throw new Error('BROWSER_AUDIT_NAVIGATION_FAILED');
        setPhase('fonts');
        await page.evaluate(async()=>{await Promise.race([document.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Font readiness timeout')),8000))]);});
        const lab=await page.evaluate(()=> (window as unknown as {__jovitaLab:{lcp:number|null;cls:number}}).__jovitaLab);
        metrics.push({width,lcp_ms:lab.lcp,cls:lab.cls,kind:'lab',advisory:true});
        // Loading offscreen images is only for inspection, after recording initial lab metrics.
        setPhase('images');
        await page.evaluate(async()=>{
          const images=Array.from(document.images);
          for(const image of images)image.loading='eager';
          await Promise.race([Promise.all(images.map(image=>image.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,8000))]);
        });
        setPhase('layout');
        const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,broken:Array.from(document.images).filter(image=>!image.complete||image.naturalWidth===0).map(image=>new URL(image.currentSrc||image.src,location.href).pathname).slice(0,20)}));
        if(layout.overflow)findings.push({width,code:'HORIZONTAL_OVERFLOW',severity:'major',evidence:'Document width exceeds viewport width.'});
        for(const path of layout.broken)findings.push({width,code:'IMAGE_NOT_LOADED',severity:'major',evidence:path});
        setPhase('accessibility');
        await page.evaluate(axe.source);
        const a11y=await page.evaluate(async()=> (window as unknown as {axe:{run:(options:unknown)=>Promise<{violations:Array<{id:string;impact:string;nodes:Array<{target:unknown}>}>;incomplete:unknown[]}>}}).axe.run({runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}));
        for(const violation of a11y.violations)findings.push({width,code:violation.id,severity:['critical','serious'].includes(violation.impact)?'major':'minor',evidence:JSON.stringify(violation.nodes.slice(0,50).map(node=>node.target)),affected_nodes:violation.nodes.length,omitted_nodes:Math.max(0,violation.nodes.length-50)});
        setPhase('keyboard');
        const keyboard=await auditKeyboard(page,width,true);
        findings.push(...keyboard.findings);
        setPhase('navigation_checks');
        const navigation = await page.evaluate(() => {
          const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')).find(a => a.hash.length > 1 && document.getElementById(decodeURIComponent(a.hash.slice(1))));
          if (!anchor) return 'not_tested';
          const target = anchor.hash; anchor.click();
          return location.hash === target ? 'pass' : 'not_tested';
        });
        setPhase('forms');
        const forms = await page.evaluate(() => Array.from(document.forms).map(form => ({controls:form.elements.length,valid:form.checkValidity()})));
        setPhase('interactions');
        const interactions: JsonObject[] = [];
        for (const check of checks) {
          formFixture = check.form_result;
          try {
            const result = await auditInteraction(page, authorizedUrl, check);
            interactions.push(result);
            if (result.status !== 'pass') findings.push({width,
              code:result.status === 'fail' ? 'INTERACTION_FAILED' : 'INTERACTION_UNVERIFIED',
              severity:result.status === 'fail' ? 'major' : 'minor', evidence:check.name,
              attempts:result.attempts, diagnostics:result.diagnostics, ...((result.diagnostics as JsonObject[])?.at(-1) ?? {})});
          } finally { formFixture = undefined; }
        }
        coverage.push({width,interactions,requested_interactions:checks.length?'see_results':'not_tested',layout:layout.overflow?'fail':'pass',images:layout.broken.length?'fail':'pass',accessibility:a11y.violations.length?'fail':a11y.incomplete.length?'not_tested':'pass',accessibility_incomplete:a11y.incomplete.length,keyboard:keyboard.complete?'pass':'not_tested',forms:{status:'native-validation-observed',results:forms,submission:'not_tested'},navigation:{same_page:navigation,cross_page:'not_tested'},focus_visibility:'visual review required',focus_samples:keyboard.samples});
      } finally {await page.close().catch(()=>{});}
      } catch (error) {
        throw browserAuditError(error, {phase, viewport:width, elapsed_ms:Date.now()-started, deadlineExpired, aborted:signal?.aborted === true});
      } finally {activeStages.delete(width);}
    }));
    coverage.sort((a,b)=>Number(a.width)-Number(b.width));
    metrics.sort((a,b)=>Number(a.width)-Number(b.width));
    // Old installed runtimes only understand pass/fail. New clients negotiate the additive status.
    if (!supportsInconclusive) for (const finding of findings) if (finding.code === 'INTERACTION_UNVERIFIED') { finding.code='INTERACTION_FAILED'; finding.severity='major'; }
    return {schema_version:'1',...identity,provider:'cloudflare_browser_rendering',checked_at:new Date().toISOString(),status:findings.some(item=>item.severity==='major')?'fail':findings.some(item=>item.code==='INTERACTION_UNVERIFIED')?'inconclusive':'pass',findings,coverage,metrics};
    })();
    return await Promise.race([operation,cancelled]);
  } catch (error) {
    const active=activeStages.entries().next().value;if(active){viewport=active[0];phase=active[1];}
    if (error instanceof BadGatewayException) throw error;
    throw browserAuditError(error, {phase, viewport, elapsed_ms: Date.now()-started, deadlineExpired, aborted: signal?.aborted === true});
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);if(browser)await closeBrowserBounded(browser);
  }
}

async function auditKeyboard(page: Page, width: number, captureSamples: boolean): Promise<{findings:JsonObject[];complete:boolean;samples:JsonObject[]}> {
  const findings:JsonObject[]=[], samples:JsonObject[]=[];
  const count=await page.evaluate(()=>document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[tabindex]').length);
  const seen=new Set<string>();
  for(let i=0;i<Math.min(count+1,MAX_CONTROLS);i++) {
    await page.keyboard.press('Tab');
    const focused=await page.evaluate(()=>{
      const element=document.activeElement as HTMLElement|null;
      if(!element||element===document.body)return null;
      const rect=element.getBoundingClientRect();const style=getComputedStyle(element);
      return {key:element.tagName+':'+Array.from(document.querySelectorAll('*')).indexOf(element),hidden:rect.width===0||rect.height===0||style.visibility==='hidden',outline:style.outlineStyle,shadow:style.boxShadow,clip:{x:Math.max(0,rect.x-8),y:Math.max(0,rect.y-8),width:Math.min(innerWidth-Math.max(0,rect.x-8),rect.width+16,500),height:Math.min(innerHeight-Math.max(0,rect.y-8),rect.height+16,180)}};
    });
    if(!focused)continue;
    if(seen.has(focused.key))break;
    seen.add(focused.key);
    if (captureSamples && width === 390 && samples.length < 3 && focused.clip.width > 0 && focused.clip.height > 0) {
      // Direct CDP avoids Puppeteer's context-wide screenshot/new-page/close mutex.
      const capture = await page.createCDPSession();
      try {
        const {data}=await capture.send('Page.captureScreenshot',{format:'jpeg',quality:50,captureBeyondViewport:false},{timeout:5000});
        samples.push({control:focused.key,media_type:'image/jpeg',data_url:`data:image/jpeg;base64,${data}`});
      } finally {await capture.detach().catch(()=>{});}
    }

    if(focused.hidden)findings.push({width,code:'FOCUS_HIDDEN',severity:'major',evidence:focused.key});
    if(focused.outline==='none'&&focused.shadow==='none')findings.push({width,code:'FOCUS_REVIEW_REQUIRED',severity:'minor',evidence:`${focused.key}: verify an alternative visible focus treatment.`});
  }
  return {findings,complete:count<MAX_CONTROLS,samples};
}

interface InteractionStep { action: 'click'|'fill'|'visible'|'hidden'|'text'|'value'|'valid'|'invalid'; selector: string; value?: string }
interface InteractionCheck { name: string; form_result?: 'success'|'error'; steps: InteractionStep[] }
export function parseInteractionChecks(input: unknown): InteractionCheck[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) throw new BadGatewayException('BROWSER_CHECKS_INVALID');
  return input.map(check => {
    if (!check || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 160 || !Array.isArray(check.steps) || !check.steps.length || check.steps.length > 12 || (check.form_result !== undefined && !['success','error'].includes(check.form_result))) throw new BadGatewayException('BROWSER_CHECKS_INVALID');
    for (const step of check.steps) if (!step || !['click','fill','visible','hidden','text','value','valid','invalid'].includes(step.action) || typeof step.selector !== 'string' || !step.selector.trim() || step.selector.length > 300 || (step.value !== undefined && (typeof step.value !== 'string' || step.value.length > 2000))) throw new BadGatewayException('BROWSER_CHECKS_INVALID');
    return check as InteractionCheck;
  });
}
/** Repeat only the same read-only/controlled-fixture check, on the same immutable URL. */
export async function auditInteraction(page: Page, url: URL, check: InteractionCheck): Promise<JsonObject> {
  const diagnostics: JsonObject[] = [];
  for (let attempt=1; attempt<=2; attempt++) {
    let index=-1;
    try {
      const response=await page.goto(url.href,{waitUntil:'load',timeout:15000});
      if (!response?.ok()) throw new Error('BROWSER_AUDIT_NAVIGATION_FAILED');
      for(index=0;index<check.steps.length;index++) await runInteractionStep(page,check.steps[index],!!check.form_result);
      return {name:check.name,status:'pass',attempts:attempt,diagnostics,submission:check.form_result?'simulated-'+check.form_result:'not_tested'};
    } catch(error) {
      const step=check.steps[index];
      const reason=error instanceof InteractionAssertionError ? 'ASSERTION_NOT_MET'
        : String((browserAuditError(error,{phase:'interactions',elapsed_ms:0}).getResponse() as JsonObject).code);
      diagnostics.push({attempt,step:index<0?'navigation':index+1,action:step?.action??'navigation',selector:step?.selector??null,reason});
    }
  }
  // Two identical explicit assertion failures are reproducible evidence. A click,
  // selector wait, protocol or navigation exception is not proof of a page defect.
  const confirmed=diagnostics.every(d=>d.reason==='ASSERTION_NOT_MET') && diagnostics[0].step===diagnostics[1].step;
  let screenshot: JsonObject={status:'unavailable'};
  try {
    const session=await page.createCDPSession();
    try {
      const {data}=await session.send('Page.captureScreenshot',{format:'jpeg',quality:50,captureBeyondViewport:false},{timeout:3000});
      screenshot={status:'captured',media_type:'image/jpeg',data_url:`data:image/jpeg;base64,${data}`};
    } finally {await session.detach().catch(()=>{});}
  } catch { /* Diagnostic capture must not replace the original result. */ }
  return {name:check.name,status:confirmed?'fail':'inconclusive',attempts:2,diagnostics,screenshot,submission:check.form_result?'simulated-'+check.form_result:'not_tested'};
}
class InteractionAssertionError extends Error {}

export async function runInteractionStep(page: Page, step: InteractionStep, formFixture = false): Promise<void> {
  if (step.action !== 'hidden') await page.waitForSelector(step.selector,{timeout:4000});
  if (step.action === 'click') {
    // Locator clicks wait for visibility, enabled state, viewport and stable bounds.
    const click=()=>page.locator(step.selector).setTimeout(5000).click();
    const submits = formFixture && await page.$eval(step.selector,element=>(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) && element.type === 'submit' && !!element.form && element.form.checkValidity());
    if (submits) await Promise.all([page.waitForNavigation({waitUntil:'load',timeout:15000}),click()]);
    else await click();
    return;
  }
  if (step.action === 'fill') {
    await page.$eval(step.selector,(element,value)=>{if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error('not a form control'); element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));},step.value ?? '');
    return;
  }
  try { await page.waitForFunction(({selector,action,value})=>{
    const element=document.querySelector(selector) as HTMLElement|null;
    if(!element)return action==='hidden';
    const visible=element.getClientRects().length>0 && getComputedStyle(element).visibility!=='hidden';
    if(action==='visible')return visible;
    if(action==='hidden')return !visible;
    if(action==='text')return (element.textContent??'').includes(value??'');
    if(action==='value')return (element as HTMLInputElement).value===value;
    if(action==='valid'||action==='invalid')return typeof (element as HTMLInputElement).checkValidity==='function' && (element as HTMLInputElement).checkValidity()===(action==='valid');
    return false;
  },{timeout:4000},step); } catch(error) {
    if (error instanceof Error && error.name === 'TimeoutError' && !/protocol|Runtime\./i.test(error.message)) throw new InteractionAssertionError('Explicit interaction assertion not met');
    throw error;
  }
}

function fixtureFormRedirect(url: URL, outcome: 'success'|'error'): URL {
  const target = new URL(url);
  target.searchParams.set('submitted', outcome === 'success' ? '1' : '0');
  if (outcome === 'error') target.searchParams.set('reason','fixture_failure');
  target.hash = 'form-' + outcome;
  return target;
}

export function browserAuditError(error: unknown, context: {phase:string;viewport?:number;elapsed_ms:number;deadlineExpired?:boolean;aborted?:boolean}): BadGatewayException {
  // Classify internally; never expose raw exception text, signed URLs, headers, or page content.
  const evidence = error instanceof Error ? `${error.name} ${error.message}` : '';
  const reason = context.aborted ? 'CANCELLED' : context.deadlineExpired ? 'DEADLINE_EXCEEDED'
    : /timeout|timed out|waiting failed/i.test(evidence) ? 'TIMEOUT'
    : /navigation_failed|net::ERR_/i.test(evidence) ? 'NAVIGATION_FAILED'
    : /target closed|session closed|connection closed|socket hang up/i.test(evidence) ? 'CONNECTION_CLOSED'
    : /401|403|unauthorized|forbidden/i.test(evidence) ? 'AUTH_FAILED'
    : /429|quota|capacity|rate limit/i.test(evidence) ? 'CAPACITY_UNAVAILABLE' : 'EXECUTION_FAILED';
  const phase = /^[a-z_]{1,40}$/.test(context.phase) ? context.phase : 'unknown';
  const viewport = WIDTHS.includes(context.viewport ?? 0) ? context.viewport : undefined;
  return new BadGatewayException({code:`BROWSER_AUDIT_${reason}`,message:`Browser audit ${reason.toLowerCase().replaceAll('_',' ')} during ${phase}${viewport ? ` at ${viewport}px` : ''}.`,phase,...(viewport ? {viewport}:{}),elapsed_ms:Math.max(0,Math.round(context.elapsed_ms)),retryable:!['AUTH_FAILED','CANCELLED'].includes(reason)});
}

async function closeBrowserBounded(browser: Browser): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([browser.close().catch(()=>{}),new Promise<void>(resolve=>{timer=setTimeout(resolve,3000);})]);}
  finally {if(timer)clearTimeout(timer);browser.disconnect?.();}
}
