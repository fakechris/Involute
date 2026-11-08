import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SafeImage } from './SafeImage';

afterEach(() => {
  cleanup();
});

function openShot() {
  render(<SafeImage src="/uploads/shot.png" alt="shot" />);
  expect(screen.queryByRole('link', { name: 'shot' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'shot' }));
  return screen.getByRole('dialog', { name: 'shot' });
}

describe('SafeImage viewer', () => {
  it('opens on this page and rotates, zooms, pans, and closes', () => {
    const dialog = openShot();
    const image = within(dialog).getByRole('img', { name: 'shot' });
    expect(image).toHaveAttribute('src', '/uploads/shot.png');
    expect(image).toHaveAttribute('data-zoom', '100');
    expect(image).toHaveAttribute('data-turn', '0');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate right' }));
    expect(image).toHaveAttribute('data-turn', '1');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate left' }));
    expect(image).toHaveAttribute('data-turn', '0');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rotate left' }));
    expect(image).toHaveAttribute('data-turn', '3');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(image).toHaveAttribute('data-zoom', '125');
    expect(within(dialog).getByText('125%')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    expect(image).toHaveAttribute('data-zoom', '100');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom out' }));
    expect(image).toHaveAttribute('data-zoom', '50');
    expect(within(dialog).getByRole('button', { name: 'Zoom out' })).toBeDisabled();

    fireEvent.pointerDown(image, { button: 0, clientX: 10, clientY: 20, pointerId: 1 });
    fireEvent.pointerMove(image, { clientX: 40, clientY: 25, pointerId: 1 });
    expect(image.style.getPropertyValue('--image-x')).toBe('30px');
    expect(image.style.getPropertyValue('--image-y')).toBe('5px');
    fireEvent.wheel(dialog, { deltaY: -40 });
    expect(image).toHaveAttribute('data-zoom', '75');
    expect(image.style.getPropertyValue('--image-x')).toBe('0px');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops at the largest zoom and closes from the backdrop', () => {
    const dialog = openShot();
    const zoomIn = within(dialog).getByRole('button', { name: 'Zoom in' });
    for (let step = 0; step < 8 && !zoomIn.hasAttribute('disabled'); step += 1) fireEvent.click(zoomIn);
    expect(within(dialog).getByRole('img', { name: 'shot' })).toHaveAttribute('data-zoom', '400');
    expect(zoomIn).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets the parent open one shared viewer', () => {
    const onOpen = vi.fn();
    render(<SafeImage src="/uploads/shot.png" alt="shot" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'shot' }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a non-allowlisted address as a link', () => {
    render(<SafeImage src="https://example.com/x.png" alt="web" />);
    const link = screen.getByRole('link', { name: 'web' });
    expect(link).toHaveAttribute('href', 'https://example.com/x.png');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('falls back to a link when the picture fails to load', () => {
    render(<SafeImage src="/uploads/shot.png" alt="shot" />);
    fireEvent.error(screen.getByRole('img', { name: 'shot' }));
    expect(screen.getByRole('link', { name: 'shot' })).toHaveAttribute('href', '/uploads/shot.png');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('leaves an unsafe address as text', () => {
    render(<SafeImage src="javascript:alert(1)" alt="script" />);
    expect(screen.getByText('script').tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
