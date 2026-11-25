import { expect, test } from 'vitest';
import * as ui from '../src/index.ts';

test('ui package loads', () => {
  expect(ui).toBeTypeOf('object');
});
