import {it,expect,vi,afterEach} from 'vitest';import puppeteer from 'puppeteer-core';
import {auditBrowserQuality,browserAuditError} from '../../src/providers/jovita-hosting/browser-quality.client.js';
const config={cloudflareAccountId:'test',cloudflareApiToken:'secret-token'} as never;
const url=new URL('https://private.test/?secret=signed-token');const identity={site_id:'site',release_id:'release',manifest_hash:'hash'};
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('returns safe phase-specific diagnostics without leaking provider errors',()=>{
 const e=browserAuditError(new Error('Timeout fetching https://private.test/?secret=signed-token Authorization: secret-token'),{phase:'images',viewport:390,elapsed_ms:100});
 expect(e.getResponse()).toMatchObject({code:'BROWSER_AUDIT_TIMEOUT',phase:'images',viewport:390,retryable:true});
 expect(JSON.stringify(e.getResponse())).not.toMatch(/signed-token|secret-token|https/);
});
it('captures connection failures before page setup',async()=>{
 vi.spyOn(puppeteer,'connect').mockRejectedValue(new Error('Unexpected server response: 403 secret-token'));
 await expect(auditBrowserQuality(config,url,identity)).rejects.toMatchObject({response:{code:'BROWSER_AUDIT_AUTH_FAILED',phase:'connect',retryable:false}});
});
it('bounds stalled connection setup and closes a late browser',async()=>{
 vi.useFakeTimers();let complete:(browser:any)=>void=()=>{};
 vi.spyOn(puppeteer,'connect').mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
 const promise=auditBrowserQuality(config,url,identity);const assertion=expect(promise).rejects.toMatchObject({response:{code:'BROWSER_AUDIT_DEADLINE_EXCEEDED',phase:'connect'}});
 await vi.advanceTimersByTimeAsync(120001);await assertion;
 const close=vi.fn().mockResolvedValue(undefined);complete({close});await vi.advanceTimersByTimeAsync(0);expect(close).toHaveBeenCalledOnce();
});
it('closes the browser and preserves failing phase on context failure',async()=>{
 const close=vi.fn().mockResolvedValue(undefined);vi.spyOn(puppeteer,'connect').mockResolvedValue({close,createBrowserContext:vi.fn().mockRejectedValue(new Error('Protocol operation timed out with secret-token'))} as never);
 await expect(auditBrowserQuality(config,url,identity)).rejects.toMatchObject({response:{code:'BROWSER_AUDIT_TIMEOUT',phase:'context'}});expect(close).toHaveBeenCalledOnce();
});
it('overlaps four viewport setups in one browser and attributes page failures',async()=>{
 let ready=0;let release:()=>void=()=>{};const allReady=new Promise<void>(resolve=>{release=resolve;});
 const close=vi.fn().mockResolvedValue(undefined);const newPage=vi.fn(async()=>({on:vi.fn(),close:vi.fn().mockResolvedValue(undefined),setViewport:async({width}:{width:number})=>{if(++ready===4)release();await allReady;throw new Error('Protocol operation timed out');}}));
 vi.spyOn(puppeteer,'connect').mockResolvedValue({close,createBrowserContext:async()=>({newPage})} as never);
 await expect(auditBrowserQuality(config,url,identity)).rejects.toMatchObject({response:{code:'BROWSER_AUDIT_TIMEOUT',phase:'page_setup',viewport:expect.any(Number)}});
 expect(puppeteer.connect).toHaveBeenCalledOnce();expect(newPage).toHaveBeenCalledTimes(4);expect(close).toHaveBeenCalledOnce();
});
it('returns after the deadline even when a provider operation and browser close never settle',async()=>{
 vi.useFakeTimers();const disconnect=vi.fn();
 vi.spyOn(puppeteer,'connect').mockResolvedValue({createBrowserContext:()=>new Promise(()=>{}),close:()=>new Promise(()=>{}),disconnect} as never);
 const pending=auditBrowserQuality(config,url,identity);const assertion=expect(pending).rejects.toMatchObject({response:{code:'BROWSER_AUDIT_DEADLINE_EXCEEDED',phase:'context'}});
 await vi.advanceTimersByTimeAsync(123001);await assertion;expect(disconnect).toHaveBeenCalledOnce();
});
