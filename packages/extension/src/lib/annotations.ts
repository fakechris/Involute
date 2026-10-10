/**
 * The annotation model of the screenshot editor (INV-1147). Shapes live in
 * screenshot pixels (the full-resolution image), so the canvas on screen can
 * be any size and the exported PNG is drawn at full resolution.
 *
 * Every change makes a new list; undo and redo walk those lists. The picked
 * element's box is a shape too ("element"), placed automatically and replaced
 * when another element is picked.
 */
export type Tool = 'rect' | 'arrow' | 'text' | 'blur';

export type Shape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number }
  | { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'text'; x: number; y: number; text: string }
  | { kind: 'blur'; x: number; y: number; width: number; height: number }
  | { kind: 'element'; x: number; y: number; width: number; height: number };

export const ANNOTATION_COLOR = '#e5484d';
export const ELEMENT_COLOR = '#3e63dd';

export class AnnotationModel {
  private history: Shape[][] = [[]];
  private index = 0;

  get shapes(): readonly Shape[] {
    return this.history[this.index]!;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.history.length - 1;
  }

  private commit(next: Shape[]): void {
    // A new change after an undo drops the undone future.
    this.history = [...this.history.slice(0, this.index + 1), next];
    this.index = this.history.length - 1;
  }

  add(shape: Shape): void {
    if (isEmpty(shape)) return;
    this.commit([...this.shapes, normalize(shape)]);
  }

  /** Put the picked element's box on the screenshot, replacing an earlier one. */
  setElementBox(box: { x: number; y: number; width: number; height: number } | null): void {
    const rest = this.shapes.filter((shape) => shape.kind !== 'element');
    this.commit(box ? [...rest, { kind: 'element', ...box }] : rest);
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.index -= 1;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.index += 1;
    return true;
  }

  /** Plain data, to keep a draft across the side panel and a larger editor tab. */
  toJSON(): { history: Shape[][]; index: number } {
    return { history: this.history, index: this.index };
  }

  static fromJSON(data: { history?: unknown; index?: unknown } | null | undefined): AnnotationModel {
    const model = new AnnotationModel();
    if (data && Array.isArray(data.history) && data.history.length > 0 && typeof data.index === 'number') {
      model.history = data.history as Shape[][];
      model.index = Math.min(Math.max(0, Math.trunc(data.index)), model.history.length - 1);
    }
    return model;
  }
}

function isEmpty(shape: Shape): boolean {
  if (shape.kind === 'text') return !shape.text.trim();
  if (shape.kind === 'arrow') return Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) < 4;
  return Math.abs(shape.width) < 3 || Math.abs(shape.height) < 3;
}

/** Boxes dragged up or left get positive sizes. */
export function normalize(shape: Shape): Shape {
  if (shape.kind === 'arrow' || shape.kind === 'text') return shape;
  const x = Math.min(shape.x, shape.x + shape.width);
  const y = Math.min(shape.y, shape.y + shape.height);
  return { ...shape, x, y, width: Math.abs(shape.width), height: Math.abs(shape.height) };
}

/** Map a pointer position on the displayed canvas to screenshot pixels. */
export function toImagePoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  image: { width: number; height: number },
): { x: number; y: number } {
  const x = ((clientX - rect.left) / rect.width) * image.width;
  const y = ((clientY - rect.top) / rect.height) * image.height;
  return { x: Math.round(Math.min(Math.max(x, 0), image.width)), y: Math.round(Math.min(Math.max(y, 0), image.height)) };
}

/** Block size for the blur: coarse enough that text inside cannot be read back. */
export function blurBlock(width: number, height: number, scale: number): number {
  return Math.max(Math.round(12 * scale), Math.round(Math.min(width, height) / 6));
}

type Context = Pick<
  CanvasRenderingContext2D,
  'drawImage' | 'save' | 'restore' | 'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'fill' | 'strokeRect' | 'fillText' | 'fillRect' | 'closePath'
> & {
  strokeStyle: CanvasRenderingContext2D['strokeStyle'];
  fillStyle: CanvasRenderingContext2D['fillStyle'];
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  imageSmoothingEnabled: boolean;
};

/**
 * Draw the screenshot and its shapes. `scale` is the screenshot's device pixel
 * ratio, so strokes and text keep their on-page size. `pixelate` draws the
 * image region at low resolution (a small offscreen canvas) for blur boxes.
 */
export function renderAnnotations(
  context: Context,
  image: CanvasImageSource & { width: number; height: number },
  shapes: readonly Shape[],
  scale: number,
  pixelate: (region: { x: number; y: number; width: number; height: number }, block: number) => CanvasImageSource | null,
): void {
  context.drawImage(image, 0, 0, image.width, image.height);
  const line = Math.max(2, Math.round(3 * scale));
  for (const shape of shapes) {
    context.save();
    if (shape.kind === 'blur') {
      const block = blurBlock(shape.width, shape.height, scale);
      const small = pixelate(shape, block);
      if (small) {
        context.imageSmoothingEnabled = false;
        context.drawImage(small, shape.x, shape.y, shape.width, shape.height);
      } else {
        context.fillStyle = '#1f2937';
        context.fillRect(shape.x, shape.y, shape.width, shape.height);
      }
    } else if (shape.kind === 'rect' || shape.kind === 'element') {
      context.strokeStyle = shape.kind === 'element' ? ELEMENT_COLOR : ANNOTATION_COLOR;
      context.lineWidth = line;
      context.strokeRect(shape.x, shape.y, shape.width, shape.height);
    } else if (shape.kind === 'arrow') {
      context.strokeStyle = ANNOTATION_COLOR;
      context.fillStyle = ANNOTATION_COLOR;
      context.lineWidth = line;
      context.beginPath();
      context.moveTo(shape.x1, shape.y1);
      context.lineTo(shape.x2, shape.y2);
      context.stroke();
      const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
      const head = 14 * scale;
      context.beginPath();
      context.moveTo(shape.x2, shape.y2);
      context.lineTo(shape.x2 - head * Math.cos(angle - Math.PI / 6), shape.y2 - head * Math.sin(angle - Math.PI / 6));
      context.lineTo(shape.x2 - head * Math.cos(angle + Math.PI / 6), shape.y2 - head * Math.sin(angle + Math.PI / 6));
      context.closePath();
      context.fill();
    } else {
      context.fillStyle = ANNOTATION_COLOR;
      context.font = `600 ${Math.round(16 * scale)}px system-ui, sans-serif`;
      context.textBaseline = 'top';
      context.fillText(shape.text, shape.x, shape.y);
    }
    context.restore();
  }
}
