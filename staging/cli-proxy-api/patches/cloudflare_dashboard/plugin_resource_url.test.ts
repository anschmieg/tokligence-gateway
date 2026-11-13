import { afterEach, expect, test } from 'bun:test';
import { resolvePluginAssetURL } from '../src/features/plugins/pluginResources';

const savedWindow = globalThis.window;
afterEach(() => { globalThis.window = savedWindow; });
const accessHost = () => {
  globalThis.window = { location: {
    protocol: 'https:', hostname: 'code.nothing.pink', origin: 'https://code.nothing.pink',
  } } as Window & typeof globalThis;
};

test('sidebar resource iframe bypasses management-only admin prefix', () => {
  accessHost();
  expect(resolvePluginAssetURL('/v0/resource/plugins/free-model-hub/console', 'https://code.nothing.pink/admin'))
    .toBe('https://code.nothing.pink/v0/resource/plugins/free-model-hub/console');
});

test('management and unrelated paths preserve native API base', () => {
  accessHost();
  expect(resolvePluginAssetURL('/v0/management/plugins/free-model-hub/console', 'https://code.nothing.pink/admin'))
    .toBe('https://code.nothing.pink/admin/v0/management/plugins/free-model-hub/console');
  expect(resolvePluginAssetURL('/v0/resource-lookalike/logo', 'https://code.nothing.pink/admin'))
    .toBe('https://code.nothing.pink/admin/v0/resource-lookalike/logo');
});

test('other deployments retain their configured resource mount prefix', () => {
  globalThis.window = { location: { protocol: 'https:', hostname: 'example.invalid' } } as Window & typeof globalThis;
  expect(resolvePluginAssetURL('/v0/resource/plugins/example/console', 'https://example.invalid/mounted'))
    .toBe('https://example.invalid/mounted/v0/resource/plugins/example/console');
});
