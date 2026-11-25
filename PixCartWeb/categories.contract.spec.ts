import '@angular/compiler';
import { TestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ShopCategoriesPage } from './out-tsc/app/app/shop/pages/categories.page.js';

beforeAll(() => TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting()));
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });
async function render(response: unknown, fails = false) {
  const fetcher = vi.fn().mockImplementation(() => fails ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true, status: 200, json: async () => response }));
  vi.stubGlobal('fetch', fetcher);
  TestBed.configureTestingModule({ imports: [ShopCategoriesPage], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ShopCategoriesPage);
  await fixture.whenStable();
  fixture.detectChanges();
  return { element: fixture.nativeElement as HTMLElement, fetcher };
}
describe('categories page', () => {
  it('uses API categories, counts and child links without hardcoded catalog data', async () => {
    const {element, fetcher} = await render([{id:'test',name:'Synthetic category',slug:'test-category',product_count:37,image_url:'',children:[{id:'child',name:'Synthetic child',slug:'test-child',product_count:2,image_url:'',children:[]}]}]);
    expect(fetcher.mock.calls[0][0]).toBe('/api/catalog/categories');
    expect(element.querySelector('h1')?.textContent).toBe('All categories');
    expect(element.querySelectorAll('section')).toHaveLength(1);
    expect(element.querySelector('a')?.getAttribute('href')).toBe('/c/test-category');
    expect(element.querySelector('li a')?.getAttribute('href')).toBe('/c/test-child');
    expect(element.textContent).toContain('37');
    expect(element.querySelector('svg path, svg polygon, svg circle')).not.toBeNull();
    expect(element.querySelector('[data-testid="placeholder-page"]')).toBeNull();
  });
  it('matches the reference empty response', async () => {
    const {element} = await render([]);
    expect(element.querySelectorAll('section')).toHaveLength(0);
    expect(element.textContent).toContain('All categories');
  });
  it('matches the reference catalog failure fallback', async () => {
    const {element} = await render(null, true);
    expect(element.querySelectorAll('section')).toHaveLength(0);
    expect(element.textContent).toContain('All categories');
  });
});
