export function sizeCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, width: number, height: number) {
  // TODO: backing-store size = CSS size × devicePixelRatio (sharp on retina screens)
  // TODO: ctx.setTransform(dpr, …) so drawing code can keep working in CSS pixels
}

// TODO: a colorblind-safe series palette (e.g. Okabe–Ito)
