import type { CSSProperties } from 'react';

/**
 * An SVG from assets/icons painted in the current text colour (theme token) through CSS mask-image,
 * because an <img> cannot recolour currentColor. Always decoration: put the meaning in words next to it.
 */
export function MaskIcon({ src, className }: { src: string; className?: string }) {
  const style = { '--icon': `url("${src}")` } as CSSProperties;
  return <span className={['icon', className].filter(Boolean).join(' ')} style={style} aria-hidden="true" />;
}
