import axe from 'axe-core';
import { expect, it } from 'vitest';
import { render } from '@testing-library/react';

it('has an axe-core accessibility gate for the web test suite', async () => {
  const { container } = render(
    <main>
      <h1>PixCart</h1>
      <button type="button">Continue</button>
    </main>,
  );
  const results = await axe.run(container);
  expect(results.violations).toEqual([]);
});
