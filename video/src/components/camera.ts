import {Easing, interpolate} from 'remotion';

/** Rectangle in source-image pixel coordinates. */
export type Rect = {x: number; y: number; w: number; h: number};
export type CamKey = {frame: number; rect: Rect};

export type Camera = {
  scale: number;
  tx: number;
  ty: number;
  /** Map an image-space rect to content-box coordinates (for overlays). */
  project: (r: Rect) => Rect;
  /** CSS transform for an element laid out at the image's natural size. */
  transform: string;
};

const ease = Easing.inOut(Easing.cubic);

/**
 * Ken-Burns camera over a large capture. Between keyframes the zoom level is
 * interpolated in log space so a 4x zoom-in feels as steady as a 1.2x pan.
 */
export const getCamera = (
  frame: number,
  boxW: number,
  boxH: number,
  keys: CamKey[],
): Camera => {
  const calc = (r: Rect) => ({
    s: Math.min(boxW / r.w, boxH / r.h),
    cx: r.x + r.w / 2,
    cy: r.y + r.h / 2,
  });

  let a = keys[0];
  let b = keys[0];
  for (let i = 0; i < keys.length; i++) {
    if (frame >= keys[i].frame) {
      a = keys[i];
      b = keys[Math.min(i + 1, keys.length - 1)];
    }
  }
  const t =
    a.frame === b.frame
      ? 0
      : ease(
          interpolate(frame, [a.frame, b.frame], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        );

  const ka = calc(a.rect);
  const kb = calc(b.rect);
  const s = Math.exp(Math.log(ka.s) + (Math.log(kb.s) - Math.log(ka.s)) * t);
  const cx = ka.cx + (kb.cx - ka.cx) * t;
  const cy = ka.cy + (kb.cy - ka.cy) * t;
  const tx = boxW / 2 - s * cx;
  const ty = boxH / 2 - s * cy;

  return {
    scale: s,
    tx,
    ty,
    project: (r) => ({x: tx + s * r.x, y: ty + s * r.y, w: s * r.w, h: s * r.h}),
    transform: `translate(${tx}px, ${ty}px) scale(${s})`,
  };
};
