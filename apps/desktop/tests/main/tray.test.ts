import { describe, it, expect, vi } from 'vitest';

import { resolveTrayIconPath, buildTrayMenuTemplate } from '../../src/main/tray.js';

describe('resolveTrayIconPath', () => {
  it('packaged → <resourcesPath>/tray/xclaude-tray-icon.png', () => {
    expect(
      resolveTrayIconPath({
        isPackaged: true,
        resourcesPath: '/App/Contents/Resources',
        mainDirUrl: 'file:///anything/out/main/index.js',
      }),
    ).toBe('/App/Contents/Resources/tray/xclaude-tray-icon.png');
  });

  it('dev → <repo>/build/xclaude-tray-icon.png (4 levels up from out/main)', () => {
    expect(
      resolveTrayIconPath({
        isPackaged: false,
        resourcesPath: '/ignored',
        mainDirUrl: 'file:///Users/x/code/xclaude-gateway/apps/desktop/out/main/index.js',
      }),
    ).toBe('/Users/x/code/xclaude-gateway/build/xclaude-tray-icon.png');
  });
});

describe('buildTrayMenuTemplate', () => {
  it('is Open (= onOpen) · separator · Quit', () => {
    const onOpen = vi.fn();
    const tpl = buildTrayMenuTemplate(onOpen);
    expect(tpl.map((i) => i.label ?? i.type)).toEqual([
      'Open xCLAUDE Gateway',
      'separator',
      'Quit xCLAUDE Gateway',
    ]);
    expect(tpl[0]?.click).toBe(onOpen);
  });
});
