import { AnnotationModel, normalize, renderAnnotations, toImagePoint, type Shape, type Tool } from '../lib/annotations';

/**
 * The screenshot editor on a canvas (INV-1147): the canvas holds the image at
 * full resolution and CSS scales it to the panel; pointer positions map back
 * to screenshot pixels, so the export is full resolution whatever the panel's
 * width.
 */
export class ScreenshotEditor {
  model = new AnnotationModel();
  tool: Tool = 'rect';
  private image: HTMLImageElement | null = null;
  private scale = 1;
  private draft: Shape | null = null;
  private start: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly textValue: () => string,
    private readonly onChange: () => void,
  ) {
    canvas.addEventListener('pointerdown', (event) => this.down(event));
    canvas.addEventListener('pointermove', (event) => this.move(event));
    canvas.addEventListener('pointerup', (event) => this.up(event));
    canvas.addEventListener('pointercancel', () => this.cancel());
  }

  get hasImage(): boolean {
    return Boolean(this.image);
  }

  async load(dataUrl: string, scale: number): Promise<void> {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    this.image = image;
    this.scale = scale > 0 ? scale : 1;
    this.canvas.width = image.naturalWidth;
    this.canvas.height = image.naturalHeight;
    this.canvas.hidden = false;
    this.draw();
  }

  setModel(model: AnnotationModel): void {
    this.model = model;
    this.draw();
  }

  undo(): void {
    if (this.model.undo()) this.changed();
  }

  redo(): void {
    if (this.model.redo()) this.changed();
  }

  private changed(): void {
    this.draw();
    this.onChange();
  }

  private point(event: PointerEvent) {
    const image = this.image!;
    return toImagePoint(event.clientX, event.clientY, this.canvas.getBoundingClientRect(), { width: image.naturalWidth, height: image.naturalHeight });
  }

  private down(event: PointerEvent): void {
    if (!this.image || event.button !== 0) return;
    const at = this.point(event);
    if (this.tool === 'text') {
      const text = this.textValue().trim();
      if (text) {
        this.model.add({ kind: 'text', x: at.x, y: at.y, text });
        this.changed();
      }
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.start = at;
    this.draft = null;
  }

  private shapeTo(at: { x: number; y: number }): Shape | null {
    if (!this.start) return null;
    if (this.tool === 'arrow') return { kind: 'arrow', x1: this.start.x, y1: this.start.y, x2: at.x, y2: at.y };
    if (this.tool === 'rect' || this.tool === 'blur') {
      return { kind: this.tool, x: this.start.x, y: this.start.y, width: at.x - this.start.x, height: at.y - this.start.y };
    }
    return null;
  }

  private move(event: PointerEvent): void {
    if (!this.start) return;
    this.draft = this.shapeTo(this.point(event));
    this.draw();
  }

  private up(event: PointerEvent): void {
    if (!this.start) return;
    const shape = this.shapeTo(this.point(event));
    this.start = null;
    this.draft = null;
    if (shape) this.model.add(shape);
    this.changed();
  }

  private cancel(): void {
    this.start = null;
    this.draft = null;
    this.draw();
  }

  private pixelate(region: { x: number; y: number; width: number; height: number }, block: number): HTMLCanvasElement | null {
    if (!this.image) return null;
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(region.width / block));
    small.height = Math.max(1, Math.round(region.height / block));
    const context = small.getContext('2d');
    if (!context) return null;
    context.imageSmoothingEnabled = true;
    context.drawImage(this.image, region.x, region.y, region.width, region.height, 0, 0, small.width, small.height);
    return small;
  }

  /** Draw onto any canvas of the image's size (the visible one, or an export). */
  private paint(target: HTMLCanvasElement, shapes: readonly Shape[]): void {
    const context = target.getContext('2d');
    if (!context || !this.image) return;
    context.clearRect(0, 0, target.width, target.height);
    // An Image that is not in the document reports its natural size as width/height.
    renderAnnotations(
      context,
      this.image,
      shapes,
      this.scale,
      (region, block) => this.pixelate(region, block),
    );
  }

  draw(): void {
    if (!this.image) return;
    const shapes = this.draft ? [...this.model.shapes, normalize(this.draft)] : this.model.shapes;
    this.paint(this.canvas, shapes);
  }

  /** The annotated screenshot as base64 PNG (no data: prefix), at full resolution. */
  exportPng(): string | null {
    if (!this.image) return null;
    const output = document.createElement('canvas');
    output.width = this.image.naturalWidth;
    output.height = this.image.naturalHeight;
    this.paint(output, this.model.shapes);
    return output.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  }
}
