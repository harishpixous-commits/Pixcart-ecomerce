import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TopList } from './out-tsc/app/app/shop/pages/top-list.js';
import { RouteState } from './out-tsc/app/app/core/route-state.js';
import { signal, computed } from '@angular/core';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
const category = {id:'synthetic',name:'Synthetic department',slug:'synthetic',product_count:4,image_url:'',children:[]};
async function setup(list = 'bestsellers', response: unknown = {category:null,tree:[category],sections:[]}, fail = false) {
  const search = signal('');
  const route = {pathname:signal(list === 'new' ? '/new-releases' : '/bestsellers'), params:computed(() => new URLSearchParams(search()))};
  const fetcher = vi.fn().mockImplementation(() => fail ? Promise.reject(new Error('offline')) : Promise.resolve({ok:true,status:200,json:async () => response}));
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({imports:[TopList],providers:[provideRouter([]),{provide:RouteState,useValue:route}]});
  const fixture = TestBed.createComponent(TopList); fixture.componentRef.setInput('list',list);
  await fixture.whenStable(); fixture.detectChanges();
  return {fixture,element:fixture.nativeElement as HTMLElement,fetcher,search};
}
describe('ranked lists', () => {
  it('loads the selected list, renders departments and the empty state', async () => {
    const {element,fetcher} = await setup();
    expect(fetcher.mock.calls[0][0]).toBe('/api/catalog/top?list=bestsellers');
    expect(element.querySelector('h1')?.textContent).toBe('Bestsellers');
    expect(element.textContent).toContain('Nothing here yet. Check back soon.');
    expect(element.querySelector('aside a[href="/bestsellers?category=synthetic"]')?.textContent).toBe('Synthetic department');
  });
  it('uses API-configured new-release days and category breadcrumb', async () => {
    const {element} = await setup('new',{category:{name:'Books',slug:'books'},breadcrumbs:[{name:'Books',slug:'books'}],tree:[],items:[],new_release_days:17});
    expect(element.querySelector('h1')?.textContent).toBe('Hot new releases in Books');
    expect(element.textContent).toContain('last 17 days');
    expect(element.querySelector('nav[aria-label="Breadcrumb"] a[href="/new-releases?category=books"]')).not.toBeNull();
  });
  it('reloads when category query changes and omits empty departments', async () => {
    const {fixture,element,search,fetcher} = await setup('bestsellers',{category:null,tree:[category,{...category,slug:'empty',name:'Empty department',product_count:0}],sections:[]});
    expect(element.textContent).not.toContain('Empty department');
    search.set('category=synthetic'); await fixture.whenStable(); fixture.detectChanges();
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/catalog/top?list=bestsellers&category=synthetic');
  });
  it('shows fetch failure rather than leaving loading placeholders forever', async () => {
    const {element} = await setup('new',null,true);
    expect(element.textContent).toContain('offline');
    expect(element.querySelector('[aria-busy]')).toBeNull();
  });
});
