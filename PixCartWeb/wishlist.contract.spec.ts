import '@angular/compiler';
import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ShopWishlistPage } from './out-tsc/app/app/shop/pages/wishlist.page.js';
import { SessionService } from './out-tsc/app/app/core/session.js';
import { WishlistService } from './out-tsc/app/app/core/wishlist.js';
import { ProductGrid } from './out-tsc/app/app/shared/product/product.js';

@Component({selector:'pc-product-grid',inputs:['items','dense'],template:'<div data-testid="test-grid">{{items.length}} items; dense={{dense}}</div>'})
class GridStub {items:unknown[]=[];dense=false;}

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
async function setup(items: unknown[] = [], signedIn = true, fail = false) {
  const ids = signal(new Set(['saved']));
  const user = signal(signedIn ? {id:'synthetic-user'} : null);
  const ready = signal(true);
  const fetcher = vi.fn().mockImplementation(() => fail ? Promise.reject(new Error('offline')) : Promise.resolve({ok:true,status:200,json:async () => ({items})}));
  vi.stubGlobal('fetch',fetcher);
  TestBed.configureTestingModule({imports:[ShopWishlistPage],providers:[provideRouter([]),{provide:SessionService,useValue:{user,ready}},{provide:WishlistService,useValue:{ids}}]});
  TestBed.overrideComponent(ShopWishlistPage,{remove:{imports:[ProductGrid]},add:{imports:[GridStub]}});
  const router = TestBed.inject(Router); const navigate = vi.spyOn(router,'navigateByUrl').mockResolvedValue(true);
  const fixture = TestBed.createComponent(ShopWishlistPage); await fixture.whenStable(); fixture.detectChanges();
  return {fixture,element:fixture.nativeElement as HTMLElement,ids,user,ready,navigate,fetcher};
}
describe('wishlist page', () => {
  it('redirects a restored guest using replace and makes no private request',async () => {
    const {navigate,fetcher,element} = await setup([],false);
    expect(navigate).toHaveBeenCalledWith('/login?next=/wishlist',{replaceUrl:true});expect(fetcher).not.toHaveBeenCalled();expect(element.querySelector('h1')).toBeNull();
  });
  it('loads API data and renders the empty state',async () => {
    const {element,fetcher}=await setup();expect(fetcher.mock.calls[0][0]).toBe('/api/wishlist');expect(element.textContent).toContain('Your wishlist');expect(element.textContent).toContain('(0)');expect(element.textContent).toContain('Nothing saved yet');expect(element.querySelector('a')?.getAttribute('href')).toBe('/');expect(element.querySelector('[data-testid="placeholder-page"]')).toBeNull();
  });
  it('filters by current saved ids, updates count immediately and passes dense products to the grid boundary',async () => {
    const product={id:'saved',slug:'synthetic',title:'Synthetic saved item'};
    const {fixture,ids,element}=await setup([product,{id:'removed'}]);
    expect(element.textContent).toContain('(1)');expect(element.querySelector('[data-testid="test-grid"]')?.textContent).toBe('1 items; dense=true');
    expect(fixture.componentInstance.shown()).toEqual([product]);
    ids.set(new Set());await fixture.whenStable();fixture.detectChanges();expect(element.textContent).toContain('(0)');expect(element.querySelector('[data-testid="test-grid"]')).toBeNull();expect(element.textContent).toContain('Nothing saved yet');
  });
  it('keeps the source loader behavior on API failure',async () => {
    const {element}=await setup([],true,true);expect(element.querySelector('h1')).toBeNull();expect(element.querySelector('pc-page-loader')).not.toBeNull();
  });
});
