import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { auditBrowserQuality } from '../../src/providers/jovita-hosting/browser-quality.client.js';
const chrome=process.env.TEST_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
describe.skipIf(!existsSync(chrome))('browser quality measured regressions',()=>{
 it.each([true,false])('measures a fixture with defects=%s using real browser pixels',async(broken)=>{
  const requests:Array<{method:string|undefined;url:string|undefined}>=[];
  const server=createServer((_request,response)=>{requests.push({method:_request.method,url:_request.url});response.setHeader('Content-Type','text/html');response.end(broken ? '<!doctype html><html lang="en"><head><title>Audit fixture</title><style>body{width:1600px;background:#777;color:#777}a:focus{outline:none}</style></head><body><main><h1>Invisible heading</h1><a href="#end">Contact</a><img src="/missing.webp" alt="broken"><p id="end">Contact us</p></main></body></html>' : '<!doctype html><html lang="en"><head><title>Clean fixture</title><style>body{margin:16px;font:18px sans-serif;color:#111;background:white}input,button{font:inherit;max-width:100%;box-sizing:border-box}a{display:inline-block;min-height:28px;margin-bottom:12px}a:focus,input:focus,button:focus{outline:3px solid blue}</style></head><body><main><h1>Contact the team</h1><a href="#contact">Contact form</a><form id="contact" method="post" action="/lead"><label for="email">Email</label><input id="email" name="email" type="email" required><button>Send</button></form></main><script>fetch("/lead",{method:"POST",body:"fixture"}).catch(()=>{});</script></body></html>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
  const connect=vi.spyOn(puppeteer,'connect').mockResolvedValue(browser);
  try {
   const result=await auditBrowserQuality({cloudflareAccountId:'test',cloudflareApiToken:'test'} as never,new URL(`http://127.0.0.1:${address.port}`),{site_id:'site',release_id:'release',manifest_hash:'hash'});
   expect(result.status, JSON.stringify(result.findings)).toBe(broken ? 'fail' : 'pass');
   if (broken) {
   expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({code:'HORIZONTAL_OVERFLOW'}),expect.objectContaining({code:'color-contrast'}),expect.objectContaining({code:'IMAGE_NOT_LOADED'})]));
   } else { expect(result.findings).toEqual([]); }
   expect(requests.some(request=>request.method==='POST'||request.url==='/lead')).toBe(false);
   expect(result.coverage).toHaveLength(4);
   expect(result.coverage).toEqual(expect.arrayContaining([expect.objectContaining({width:390,focus_samples:expect.any(Array)})]));
  }finally {connect.mockRestore();await browser.close().catch(()=>{});await new Promise<void>(resolve=>server.close(()=>resolve()));}
 },120000);
});
