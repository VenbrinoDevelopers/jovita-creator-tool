import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { auditBrowserQuality, parseInteractionChecks } from '../../src/providers/jovita-hosting/browser-quality.client.js';
const chrome = process.env.TEST_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
it('rejects arbitrary code and oversized interaction scripts', () => {
  expect(() => parseInteractionChecks([{name:'code',steps:[{action:'evaluate',selector:'body',value:'process.exit()'}]}])).toThrow('BROWSER_CHECKS_INVALID');
  expect(() => parseInteractionChecks(Array(9).fill({}))).toThrow('BROWSER_CHECKS_INVALID');
});
describe.skipIf(!existsSync(chrome))('agent-authored landing-page interactions', () => {
  it('tests filters, navigation, gallery, dates, and both simulated form outcomes without sending a lead', async () => {
    const requests: string[] = [];
    const html = `<!doctype html><html lang="en"><head><title>Restaurant demonstration</title><style>body{margin:16px;font:18px system-ui;color:#111;background:#fff}button,input{font:inherit;padding:12px;max-width:100%;box-sizing:border-box}button{margin:8px}label{display:block} :focus-visible{outline:3px solid blue}#form-success,#form-error{display:none}#form-success:target,#form-error:target{display:block}</style></head><body><main><h1>Restaurant demonstration</h1><p>Demo form: no reservation is placed.</p><button id="menu" type="button" aria-expanded="false" aria-controls="navigation">Menu</button><nav id="navigation" hidden><a href="#booking">Enquire</a></nav><button id="vegan" type="button">Vegan dishes</button><p data-dish="vegan">Vegetables</p><p data-dish="fish">Fish</p><button id="next" type="button">Next gallery item</button><p id="gallery">Dining room</p><form id="booking" method="post" action="/__jovita/forms/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"><label for="email">Email</label><input id="email" name="email" type="email" required><label for="date">Date</label><input id="date" name="date" type="date" required><button id="send" type="submit">Send demo request</button></form><p id="form-success" role="status">Demo request accepted</p><p id="form-error" role="alert">Demo delivery failed</p></main><script>document.querySelector('#menu').addEventListener('click',()=>{const menu=document.querySelector('#navigation');menu.hidden=!menu.hidden;document.querySelector('#menu').setAttribute('aria-expanded',String(!menu.hidden));});document.querySelector('#vegan').addEventListener('click',()=>document.querySelectorAll('[data-dish]').forEach(dish=>dish.hidden=dish.dataset.dish!=='vegan'));document.querySelector('#next').addEventListener('click',()=>document.querySelector('#gallery').textContent='Terrace');const date=document.querySelector('#date');date.addEventListener('input',()=>date.setCustomValidity(date.value<new Date().toISOString().slice(0,10)?'Choose a future date':''));</script></body></html>`;
    const server = createServer((request,response)=>{requests.push(request.method ?? '');response.setHeader('Content-Type','text/html');response.end(html);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const browser = await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
    const connect=vi.spyOn(puppeteer,'connect').mockResolvedValue(browser);
    const fill=[{action:'fill',selector:'#email',value:'demo@example.test'},{action:'fill',selector:'#date',value:new Date(Date.now()+86400000).toISOString().slice(0,10)}];
    try {
      const result=await auditBrowserQuality({cloudflareAccountId:'test',cloudflareApiToken:'test'} as never,new URL(`http://127.0.0.1:${(server.address() as {port:number}).port}/`),{preview_id:'preview',revision:'a'.repeat(64)},undefined,[
        {name:'menu filter',steps:[{action:'click',selector:'#vegan'},{action:'hidden',selector:'[data-dish="fish"]'},{action:'visible',selector:'[data-dish="vegan"]'}]},
        {name:'mobile navigation',steps:[{action:'click',selector:'#menu'},{action:'visible',selector:'#navigation'}]},
        {name:'gallery',steps:[{action:'click',selector:'#next'},{action:'text',selector:'#gallery',value:'Terrace'}]},
        {name:'past date',steps:[{action:'fill',selector:'#date',value:'1999-01-01'},{action:'invalid',selector:'#date'}]},
        ...(['success','error'] as const).map(outcome=>({name:`form ${outcome}`,form_result:outcome,steps:[...fill,{action:'click',selector:'#send'},{action:'visible',selector:`#form-${outcome}`}]})),
      ]);
      expect(result.status,JSON.stringify(result.findings)).toBe('pass');
      for(const row of result.coverage as Array<{interactions:Array<{status:string}>}>)expect(row.interactions.map(i=>i.status)).toEqual(Array(6).fill('pass'));
      expect(requests).not.toContain('POST');
    } finally {connect.mockRestore();await browser.close().catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },120000);
});
