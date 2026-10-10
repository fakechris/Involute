import { describe, expect, it, vi } from 'vitest';

import { AnnotationModel, blurBlock, normalize, renderAnnotations, toImagePoint } from './annotations';

describe('AnnotationModel', () => {
  it('undoes and redoes, and a new change drops the undone future', () => {
    const model = new AnnotationModel();
    model.add({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 });
    model.add({ kind: 'arrow', x1: 0, y1: 0, x2: 50, y2: 50 });
    expect(model.shapes).toHaveLength(2);
    expect(model.undo()).toBe(true);
    expect(model.shapes.map((shape) => shape.kind)).toEqual(['rect']);
    expect(model.canRedo).toBe(true);
    expect(model.redo()).toBe(true);
    expect(model.shapes).toHaveLength(2);
    model.undo();
    model.add({ kind: 'text', x: 5, y: 5, text: 'here' });
    expect(model.canRedo).toBe(false);
    expect(model.shapes.map((shape) => shape.kind)).toEqual(['rect', 'text']);
    model.undo();
    model.undo();
    expect(model.shapes).toEqual([]);
    expect(model.undo()).toBe(false);
  });

  it('ignores empty shapes and normalizes boxes dragged up-left', () => {
    const model = new AnnotationModel();
    model.add({ kind: 'rect', x: 0, y: 0, width: 1, height: 40 });
    model.add({ kind: 'text', x: 0, y: 0, text: '  ' });
    model.add({ kind: 'arrow', x1: 0, y1: 0, x2: 1, y2: 1 });
    expect(model.shapes).toEqual([]);
    model.add({ kind: 'blur', x: 100, y: 100, width: -40, height: -20 });
    expect(model.shapes[0]).toEqual({ kind: 'blur', x: 60, y: 80, width: 40, height: 20 });
    expect(normalize({ kind: 'arrow', x1: 9, y1: 9, x2: 0, y2: 0 })).toEqual({ kind: 'arrow', x1: 9, y1: 9, x2: 0, y2: 0 });
  });

  it('keeps one element box, replaced on a new pick, and undoable', () => {
    const model = new AnnotationModel();
    model.add({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 });
    model.setElementBox({ x: 1, y: 2, width: 3, height: 4 });
    model.setElementBox({ x: 5, y: 6, width: 7, height: 8 });
    expect(model.shapes.filter((shape) => shape.kind === 'element')).toEqual([{ kind: 'element', x: 5, y: 6, width: 7, height: 8 }]);
    model.undo();
    expect(model.shapes.find((shape) => shape.kind === 'element')).toMatchObject({ x: 1 });
  });

  it('round-trips through JSON for the draft', () => {
    const model = new AnnotationModel();
    model.add({ kind: 'rect', x: 0, y: 0, width: 10, height: 10 });
    model.add({ kind: 'rect', x: 5, y: 5, width: 10, height: 10 });
    model.undo();
    const copy = AnnotationModel.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
    expect(copy.shapes).toHaveLength(1);
    expect(copy.canRedo).toBe(true);
    expect(AnnotationModel.fromJSON(null).shapes).toEqual([]);
  });
});

describe('geometry and rendering', () => {
  it('maps the displayed canvas to screenshot pixels', () => {
    expect(toImagePoint(150, 75, { left: 100, top: 50, width: 400, height: 200 }, { width: 2560, height: 1280 })).toEqual({ x: 320, y: 160 });
    expect(toImagePoint(0, 0, { left: 100, top: 50, width: 400, height: 200 }, { width: 2560, height: 1280 })).toEqual({ x: 0, y: 0 });
  });

  it('blurs with blocks coarse enough to hide text', () => {
    expect(blurBlock(30, 30, 2)).toBe(24);
    expect(blurBlock(600, 600, 1)).toBe(100);
  });

  it('draws the image, then every shape; a blur without pixelation falls back to a solid box', () => {
    const calls: string[] = [];
    const context = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => calls.push(`${key}(${args.filter((a) => typeof a === 'number').join(',')})`)),
      set: (target, key: string, value) => {
        target[key] = value;
        return true;
      },
    });
    const image = { width: 100, height: 50 } as unknown as HTMLImageElement;
    const pixelate = vi.fn(() => null);
    renderAnnotations(context as never, image, [
      { kind: 'rect', x: 1, y: 2, width: 3, height: 4 },
      { kind: 'blur', x: 5, y: 6, width: 7, height: 8 },
      { kind: 'element', x: 9, y: 9, width: 9, height: 9 },
      { kind: 'text', x: 1, y: 1, text: 'here' },
    ], 2, pixelate);
    expect(calls[0]).toBe('drawImage(0,0,100,50)');
    expect(calls).toContain('strokeRect(1,2,3,4)');
    expect(calls).toContain('fillRect(5,6,7,8)');
    expect(calls).toContain('strokeRect(9,9,9,9)');
    expect(calls).toContain('fillText(1,1)');
    expect(pixelate).toHaveBeenCalledOnce();
  });
});
