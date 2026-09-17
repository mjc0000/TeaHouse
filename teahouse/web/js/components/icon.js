/**
 * Inline icons.
 *
 * Hand-drawn 24×24 stroke paths: no icon set, no font, no request and no
 * dependency. They are drawn with `currentColor`, so an icon follows the colour
 * of whatever it sits in — a muted category, the highlighted selected one — for
 * free, and `stroke-width` is tuned for the 16px size they are used at.
 */

/** Add a name here and the navigation can use it; test:web cross-checks both sides. */
export const ICON_PATHS = {
  /** Category: general settings — sliders. */
  sliders: 'M4 8h9M17 8h3M4 16h3M11 16h9M15 5.5v5M9 13.5v5',
  /** Category: the model — a chip with pins. */
  chip: 'M7 7h10v10H7zM9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
  /** Category: role play — a person. */
  user: 'M12 12.5a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  /** Category: world books — an open book. */
  book: 'M12 6.2C10.4 4.9 8.3 4.2 5.5 4.2v13.6c2.8 0 4.9.7 6.5 2 1.6-1.3 3.7-2 6.5-2V4.2c-2.8 0-4.9.7-6.5 2ZM12 6.2v13.6',
  /** Theme: light — a sun. */
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2.2M12 19.3v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6',
  /** Theme: dark — a moon. */
  moon: 'M20 14.2A8.2 8.2 0 0 1 9.8 4a8.5 8.5 0 1 0 10.2 10.2Z',
  /** Theme: follow the system — a screen. */
  monitor: 'M3.5 5h17v11h-17zM9 20h6M12 16v4',
  /** Appearance button — a painter's palette. */
  palette:
      'M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-.9 2-1.8 0-1.6-1.6-1.4-1.6-2.7 0-.8.7-1.5 1.6-1.5h1.6a4.9 4.9 0 0 0 4.8-4.9c0-3.4-3.8-6.1-8.4-6.1ZM7.6 12.6a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2ZM10.4 9a1.1 1.1 0 1 0 0-2.2A1.1 1.1 0 0 0 10.4 9ZM14.6 9.4a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2Z',
  /** Voice page — a speaker with sound waves. */
  speech:
      'M4 10v4h3l4 4V6L7 10H4ZM14.5 9a4.2 4.2 0 0 1 0 6M17 6.5a8 8 0 0 1 0 11',
  };

/**
 * @param {keyof ICON_PATHS | string} name
 * @param {{ size?: number, className?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, options = {}) {
  const size = options.size ?? 16;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ['icon', options.className].filter(Boolean).join(' '));
  // Decorative: the label next to it carries the meaning.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.sliders);
  svg.append(path);
  return svg;
}
