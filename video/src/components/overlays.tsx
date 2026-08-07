import React from 'react';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {theme} from '../theme';
import type {Rect} from './camera';

/** Spring fade+rise entrance; optional fade-out at `until`. */
export const useReveal = (at: number, until?: number) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame: frame - at, fps, config: {damping: 200}});
  const exit =
    until === undefined
      ? 1
      : interpolate(frame, [until - 10, until], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  return {opacity: enter * exit, rise: (1 - enter) * 26};
};

/** Big centered statement, one thought per beat. */
export const TitleBeat: React.FC<{
  at: number;
  until?: number;
  size?: number;
  color?: string;
  sub?: string;
  subColor?: string;
  children: React.ReactNode;
}> = ({at, until, size = 96, color = theme.ink, sub, subColor, children}) => {
  const {opacity, rise} = useReveal(at, until);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        opacity,
        transform: `translateY(${rise}px)`,
      }}
    >
      <div
        style={{
          fontFamily: theme.font,
          fontWeight: 800,
          fontSize: size,
          letterSpacing: '-0.02em',
          color,
          textAlign: 'center',
          lineHeight: 1.08,
          maxWidth: 1500,
          textShadow:
            '0 2px 30px rgba(255,255,255,0.85), 0 1px 8px rgba(255,255,255,0.6)',
        }}
      >
        {children}
      </div>
      {sub ? (
        <div
          style={{
            fontFamily: theme.font,
            fontWeight: 500,
            fontSize: 40,
            color: subColor ?? theme.muted,
            textAlign: 'center',
            textShadow:
              '0 2px 30px rgba(255,255,255,0.9), 0 1px 8px rgba(255,255,255,0.7)',
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  );
};

/** Caption pill pinned near the bottom — readable over any capture. */
export const Caption: React.FC<{
  at: number;
  until?: number;
  bottom?: number;
  children: React.ReactNode;
}> = ({at, until, bottom = 64, children}) => {
  const {opacity, rise} = useReveal(at, until);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom,
        display: 'flex',
        justifyContent: 'center',
        opacity,
        transform: `translateY(${rise}px)`,
      }}
    >
      <div
        style={{
          background: theme.pillBg,
          color: theme.pillText,
          fontFamily: theme.font,
          fontWeight: 600,
          fontSize: 36,
          lineHeight: 1.35,
          padding: '18px 40px',
          borderRadius: 20,
          maxWidth: 1500,
          textAlign: 'center',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        }}
      >
        {children}
      </div>
    </div>
  );
};

/** Small status chip (e.g. "LIVE — promit-two.vercel.app"). */
export const Chip: React.FC<{
  at: number;
  until?: number;
  x: number;
  y: number;
  dot?: string;
  children: React.ReactNode;
}> = ({at, until, x, y, dot, children}) => {
  const {opacity, rise} = useReveal(at, until);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(10,10,10,0.12)',
        borderRadius: 999,
        padding: '12px 26px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
        opacity,
        transform: `translateY(${rise}px)`,
      }}
    >
      {dot ? (
        <div style={{width: 14, height: 14, borderRadius: 7, background: dot}} />
      ) : null}
      <span
        style={{
          fontFamily: theme.font,
          fontWeight: 600,
          fontSize: 27,
          color: theme.ink,
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
    </div>
  );
};

/**
 * Amber highlight stroked around a projected capture rect. `box` is already
 * in content-box coordinates (use camera.project) so it tracks the pan.
 */
export const HighlightBox: React.FC<{
  at: number;
  until?: number;
  box: Rect;
}> = ({at, until, box}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const enter = spring({frame: frame - at, fps, config: {damping: 16, stiffness: 180}});
  const exit =
    until === undefined
      ? 1
      : interpolate(frame, [until - 8, until], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
  if (frame < at) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        border: `4px solid ${theme.amber}`,
        background: 'rgba(245,158,11,0.10)',
        borderRadius: 12,
        opacity: exit,
        transform: `scale(${0.9 + 0.1 * enter})`,
        boxShadow: '0 0 0 6px rgba(245,158,11,0.15)',
      }}
    />
  );
};
