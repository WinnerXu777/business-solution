import rawFixtures from '../fixtures/demo.json' with { type: 'json' };
import type { DemoFixtures } from './generated.ts';

export function loadDemoFixtures(): DemoFixtures {
  return structuredClone(rawFixtures) as DemoFixtures;
}
