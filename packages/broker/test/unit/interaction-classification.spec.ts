import {it,expect,vi} from 'vitest';
import {auditInteraction} from '../../src/providers/jovita-hosting/browser-quality.client.js';
function page() {const click=vi.fn();return {locator:()=>({setTimeout:()=>({click})}),goto:vi.fn().mockResolvedValue({ok:()=>true}),waitForSelector:vi.fn().mockResolvedValue({}),click,waitForFunction:vi.fn(),createCDPSession:vi.fn().mockRejectedValue(new Error('capture unavailable'))};}
const url=new URL('https://private.test/?secret=do-not-expose');
it('retries one transport failure on the same URL and preserves its diagnostic',async()=>{
 const p=page();p.click.mockRejectedValueOnce(new Error('Protocol timeout '+url)).mockResolvedValueOnce(undefined);
 const r=await auditInteraction(p as never,url,{name:'menu',steps:[{action:'click',selector:'#menu'}]});
 expect(r.status).toBe('pass');expect(r.attempts).toBe(2);expect(p.goto.mock.calls.map(c=>c[0])).toEqual([url.href,url.href]);expect(JSON.stringify(r)).not.toContain('do-not-expose');
});
it('does not convert repeated click exceptions into a measured defect',async()=>{
 const p=page();p.click.mockRejectedValue(new Error('Node is either not clickable or not an Element'));
 const r=await auditInteraction(p as never,url,{name:'menu',steps:[{action:'click',selector:'#menu'}]});
 expect(r.status).toBe('inconclusive');expect(p.click).toHaveBeenCalledTimes(2);expect(r.screenshot).toEqual({status:'unavailable'});
});
it('retains reproducible explicit assertion failures as defects',async()=>{
 const p=page();p.waitForFunction.mockRejectedValue(Object.assign(new Error('Waiting failed'),{name:'TimeoutError'}));
 const r=await auditInteraction(p as never,url,{name:'menu opens',steps:[{action:'visible',selector:'#nav'}]});
 expect(r.status).toBe('fail');expect(r.attempts).toBe(2);
});
it('does not misclassify protocol timeouts as assertion failures',async()=>{
 const p=page();p.waitForFunction.mockRejectedValue(Object.assign(new Error('Runtime.callFunctionOn protocol timeout'),{name:'TimeoutError'}));
 expect((await auditInteraction(p as never,url,{name:'menu',steps:[{action:'visible',selector:'#nav'}]})).status).toBe('inconclusive');
});
