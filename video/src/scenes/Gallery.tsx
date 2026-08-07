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
import {Caption, Chip} from '../components/overlays';
import {theme} from '../theme';

export const GALLERY_LEN = 360;

const FRAME_W = 1680;
const FRAME_H = 964;
const IMG_W = 3840;
const IMG_H = 6290;

/**
 * One continuous scroll through the full-page capture of /prompts — the
 * whole populated catalog in a single unbroken take, nothing curated out.
 */
export const Gallery: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {w: boxW, h: boxH} = browserContentSize(FRAME_W, FRAME_H);
  const viewH = (IMG_W * boxH) / boxW;

  const enter = spring({frame, fps, config: {damping: 200}});
  const cam = getCamera(frame, boxW, boxH, [
    {frame: 30, rect: {x: 0, y: 0, w: IMG_W, h: viewH}},
    {frame: 345, rect: {x: 0, y: IMG_H - viewH, w: IMG_W, h: viewH}},
  ]);

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: enter,
          transform: `translateY(${(1 - enter) * 60}px)`,
        }}
      >
        <BrowserFrame
          url="promit-two.vercel.app/prompts"
          width={FRAME_W}
          height={FRAME_H}
        >
          <Img
            src={staticFile('captures/gallery-full.png')}
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
      <Chip at={40} x={118} y={952} dot={theme.green}>
        GET /v1/catalog — 23 entries
      </Chip>
      <Caption at={55} until={200}>
        23 prompts live. Every preview is real output.
      </Caption>
      <Caption at={220} until={GALLERY_LEN - 12}>
        Free prompts copy instantly — paid ones unlock for cents of USDC.
      </Caption>
    </AbsoluteFill>
  );
};
