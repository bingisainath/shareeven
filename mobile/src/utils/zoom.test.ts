import { clampOffset, fitSize, NO_ZOOM, settle, toggleZoom, zoomAt } from './zoom';

const box = { width: 400, height: 800 };
const landscape = fitSize({ width: 4000, height: 3000 }, box); // 400 x 300 on screen

describe('zoom', () => {
  it('fits a picture inside its box', () => {
    expect(landscape).toEqual({ width: 400, height: 300 });
    expect(fitSize({ width: 1000, height: 4000 }, box)).toEqual({ width: 200, height: 800 });
    expect(fitSize(null, box)).toEqual(box);
  });

  it('keeps the pinched spot under the fingers', () => {
    const z = zoomAt(NO_ZOOM, { x: 100, y: -50 }, 2);
    // the spot at (100, -50) was 100 px right of the picture centre; now 200 px, so the picture moves 100 px left
    expect(z).toEqual({ scale: 2, x: -100, y: 50 });
    expect(z.x + 100 * z.scale).toBe(100);
  });

  it("can't drag a zoomed picture off screen, and centres it where it's narrower than the screen", () => {
    // 2x: 800 x 600 in a 400 x 800 box -> 200 px of room left/right, none up/down
    expect(clampOffset({ scale: 2, x: 999, y: 999 }, landscape, box)).toEqual({ scale: 2, x: 200, y: 0 });
    expect(clampOffset({ scale: 2, x: -999, y: -10 }, landscape, box)).toEqual({ scale: 2, x: -200, y: 0 });
  });

  it('springs back from too little or too much zoom', () => {
    expect(settle({ scale: 0.7, x: 30, y: 30 }, landscape, box)).toEqual(NO_ZOOM);
    expect(settle({ scale: 1.005, x: 3, y: 0 }, landscape, box)).toEqual(NO_ZOOM);
    expect(settle({ scale: 8, x: 0, y: 0 }, landscape, box).scale).toBe(5);
  });

  it('double-tap zooms in on the spot, and out again', () => {
    const z = toggleZoom(NO_ZOOM, { x: 150, y: 0 }, landscape, box);
    expect(z.scale).toBe(2.5);
    expect(z.x).toBe(-225); // 150 - 150 * 2.5, inside the 300 px of room
    expect(toggleZoom(z, { x: 0, y: 0 }, landscape, box)).toEqual(NO_ZOOM);
  });
});
