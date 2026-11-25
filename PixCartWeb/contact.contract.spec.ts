import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ShopContactPage } from './out-tsc/app/app/shop/pages/contact.page.js';
import { SiteService } from './out-tsc/app/app/core/site.js';
import { FALLBACK_SITE } from './out-tsc/app/app/core/site-defaults.js';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => TestBed.resetTestingModule());
async function render(overrides: object) {
 const site=signal({...structuredClone(FALLBACK_SITE),...overrides});
 TestBed.configureTestingModule({imports:[ShopContactPage],providers:[provideRouter([]),{provide:SiteService,useValue:{site}}]});
 const fixture=TestBed.createComponent(ShopContactPage); await fixture.whenStable(); fixture.detectChanges();
 return {element:fixture.nativeElement as HTMLElement,site,fixture};
}
describe('configured contact screen', () => {
 it('renders configured business, active contact and social sections', async () => {
  const {element}=await render({contact:{enabled:true,title:'Synthetic care',items:[{id:'test',type:'email',label:'Care',value:'synthetic@example.invalid',enabled:true}]},social:{enabled:true,title:'Synthetic social',links:[{id:'test',icon:'globe',label:'Synthetic link',url:'https://example.invalid',enabled:true}]},business:{legal_name:'Synthetic company',registered_address:'Synthetic address',gstin:'TESTGST',cin:'TESTCIN'}});
  expect(element.querySelector('h1')?.textContent).toBe('Synthetic care');
  expect(element.querySelector('a[href="mailto:synthetic@example.invalid"]')).not.toBeNull();
  expect(element.querySelector('a[href="https://example.invalid"]')?.getAttribute('rel')).toContain('noopener');
  expect(element.textContent).toContain('Synthetic company');
  expect(element.textContent).toContain('GSTIN TESTGST');
  expect(element.querySelector('a[href="/help/grievance"]')).not.toBeNull();
 });
 it('hides disabled/absent sections while preserving order and support routes', async () => {
  const {element}=await render({contact:{enabled:false,title:'',items:[]},social:{enabled:false,title:'',links:[]},business:{legal_name:'',registered_address:'',gstin:'',cin:''}});
  expect(element.querySelector('h1')?.textContent).toBe('Contact us');
  expect(element.textContent).not.toContain('Reach us');
  expect(element.textContent).not.toContain('Registered office');
  expect(element.querySelector('a[href="/orders"]')).not.toBeNull();
  expect(element.querySelector('a[href="/support/new"]')).not.toBeNull();
 });
});
