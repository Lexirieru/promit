import React from 'react';
import {
  AbsoluteFill,
  Img,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {BrowserFrame, browserContentSize} from '../components/BrowserFrame';
import {getCamera} from '../components/camera';
import {Chip, TitleBeat} from '../components/overlays';
import {theme} from '../theme';

export const LANDING_LEN = 330;

const FRAME_W = 1680;
const FRAME_H = 964;
const IMG_W = 3840;
const IMG_H = 2160;

/**
 * The pivot. The claim is spoken once as text, then proven by the real
 * landing page carrying the exact same headline.
 */
export const Landing: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {w: boxW, h: boxH} = browserContentSize(FRAME_W, FRAME_H);

  const enter = spring({frame: frame - 72, fps, config: {damping: 200}});
  const cam = getCamera(frame, boxW, boxH, [
    {frame: 90, rect: {x: 0, y: 0, w: IMG_W, h: (IMG_W * boxH) / boxW}},
    {frame: 320, rect: {x: 210, y: 130, w: 3420, h: (3420 * boxH) / boxW}},
  ]);

  return (
    <AbsoluteFill>
      <TitleBeat at={4} until={68} size={104}>
        Pay per prompt.
        <br />
        Not per month.
      </TitleBeat>
      {frame >= 68 ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            opacity: enter,
            transform: `translateY(${(1 - enter) * 70}px)`,
          }}
        >
          <BrowserFrame url="promit-two.vercel.app" width={FRAME_W} height={FRAME_H}>
            <Img
              src={staticFile('captures/landing-hero.png')}
              style={{
                position: 'absolute',
                width: IMG_W,
                height: IMG_H,
                transformOrigin: '0 0',
                transform: cam.transform,
              }}
            />
          </BrowserFrame>
        </AbsoluteFill>
      ) : null}
      <Chip at={120} x={118} y={952} dot={theme.green}>
        LIVE — promit-two.vercel.app
      </Chip>
    </AbsoluteFill>
  );
};
