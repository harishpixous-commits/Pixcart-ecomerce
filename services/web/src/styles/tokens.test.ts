import { describe, expect, it } from 'vitest';

const palette = {
  navy: '#17365d',
  green: '#1e7b45',
  warning: '#9c6500',
  danger: '#b23b3b',
  info: '#1f4e79',
  borderControl: '#737e8e',
  white: '#ffffff',
} as const;

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

describe('Pix DS colour tokens', () => {
  it('keeps normal text at WCAG AA contrast on white', () => {
    for (const colour of [palette.navy, palette.green, palette.warning, palette.danger, palette.info]) {
      expect(contrast(colour, palette.white)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps interactive control boundaries at the 3:1 UI threshold', () => {
    expect(contrast(palette.borderControl, palette.white)).toBeGreaterThanOrEqual(3);
  });

  it('defines the documented minimum target size', () => {
    expect(24).toBeGreaterThanOrEqual(24);
  });
});
