import React from 'react';
import {theme} from '../theme';

const CHROME_H = 64;

/**
 * Minimal browser chrome around every site/explorer capture. The address bar
 * shows the real URL — judges should be able to retype what they see.
 */
export const BrowserFrame: React.FC<{
  url: string;
  width: number;
  height: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({url, width, height, style, children}) => (
  <div
    style={{
      width,
      height,
      borderRadius: 18,
      overflow: 'hidden',
      background: '#FFFFFF',
      boxShadow: '0 30px 80px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.10)',
      ...style,
    }}
  >
    <div
      style={{
        height: CHROME_H,
        background: '#EEEFF1',
        borderBottom: '1px solid #DFE1E5',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 10,
      }}
    >
      {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
        <div
          key={c}
          style={{width: 14, height: 14, borderRadius: 7, background: c}}
        />
      ))}
      <div
        style={{
          margin: '0 auto',
          height: 38,
          minWidth: 620,
          borderRadius: 19,
          background: '#FFFFFF',
          border: '1px solid #DFE1E5',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: '0 26px',
        }}
      >
        <svg width="15" height="17" viewBox="0 0 15 17" fill="none">
          <rect x="1" y="7" width="13" height="9" rx="2" fill="#5F6368" />
          <path
            d="M4 7V5a3.5 3.5 0 1 1 7 0v2"
            stroke="#5F6368"
            strokeWidth="1.8"
            fill="none"
          />
        </svg>
        <span
          style={{
            fontFamily: theme.font,
            fontSize: 22,
            color: '#3C4043',
            whiteSpace: 'nowrap',
          }}
        >
          {url}
        </span>
      </div>
      <div style={{width: 62}} />
    </div>
    <div
      style={{
        position: 'relative',
        width,
        height: height - CHROME_H,
        overflow: 'hidden',
        background: '#FFFFFF',
      }}
    >
      {children}
    </div>
  </div>
);

export const browserContentSize = (width: number, height: number) => ({
  w: width,
  h: height - CHROME_H,
});
