import { useEffect, useRef, useState } from 'react';
import { RotateCcw, RotateCw, Crop, Image as ImageIcon, ChevronDown, ChevronUp } from 'lucide-react';
import type { Box, CardImage } from '../../shared/types';

interface Props {
  cards: CardImage[];
  focus: Box | null;
  busy: boolean;
  onRescan: (opts: { cardId: string; rotation?: number; crop?: Box }) => void;
}

/** Shows the image used for extraction (with the evidence box of the focused field) or the original photo. */
export function CardViewer({ cards, focus, busy, onRescan }: Props) {
  const [idx, setIdx] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [cropping, setCropping] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [rect, setRect] = useState<Box | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const card = cards[Math.min(idx, cards.length - 1)];

  useEffect(() => {
    setRect(null);
  }, [cropping, idx]);

  if (!card)
    return (
      <div className="viewer">
        <div className="empty" style={{ color: '#cfd8de' }}>
          No card photo. Typed contact.
        </div>
      </div>
    );

  const variant = cropping || showOriginal ? 'original' : 'processed';
  const src = `/api/cards/${card.id}/image?variant=${variant}&v=${encodeURIComponent(card.processedAt ?? card.createdAt)}`;
  // Evidence boxes are in processed-image pixels; convert to percentages so they scale with the image.
  const pw = card.processedWidth || nat?.w || 1,
    ph = card.processedHeight || nat?.h || 1;
  const showFocus = focus && variant === 'processed' && idx === 0;

  function pos(e: React.PointerEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }

  return (
    <div className={`viewer ${collapsed ? 'viewer-collapsed' : ''}`}>
      <div className="viewer-stage">
        <img
          ref={imgRef}
          src={src}
          alt={`Card photo${cards.length > 1 ? ` (${card.side})` : ''}`}
          onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        />
        {showFocus && focus && (
          <div
            className="evidence"
            style={{ left: `${(100 * focus.x) / pw}%`, top: `${(100 * focus.y) / ph}%`, width: `${(100 * focus.w) / pw}%`, height: `${(100 * focus.h) / ph}%` }}
          />
        )}
        {cropping && (
          <div
            className="crop-layer"
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              start.current = pos(e);
              setRect({ ...start.current, w: 0, h: 0 });
            }}
            onPointerMove={(e) => {
              if (!start.current) return;
              const p = pos(e);
              setRect({
                x: Math.min(p.x, start.current.x),
                y: Math.min(p.y, start.current.y),
                w: Math.abs(p.x - start.current.x),
                h: Math.abs(p.y - start.current.y),
              });
            }}
            onPointerUp={() => (start.current = null)}
            aria-label="Drag over the card to select it"
          >
            {rect && (
              <div className="crop-rect" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
            )}
          </div>
        )}
      </div>
      <div className="viewer-bar">
        {cards.length > 1 && (
          <button className="btn" onClick={() => setIdx((idx + 1) % cards.length)}>
            {card.side === 'back' ? 'Show front' : 'Show back'}
          </button>
        )}
        {!cropping && (
          <>
            <button
              className="btn"
              aria-pressed={showOriginal}
              onClick={() => setShowOriginal(!showOriginal)}
              title="Switch between the corrected image used for reading and your original photo"
            >
              <ImageIcon size={16} /> {showOriginal ? 'Original photo' : 'Read image'}
            </button>
            <button className="btn" disabled={busy} onClick={() => onRescan({ cardId: card.id, rotation: 3 })} aria-label="Rotate left and read again">
              <RotateCcw size={16} />
            </button>
            <button className="btn" disabled={busy} onClick={() => onRescan({ cardId: card.id, rotation: 1 })} aria-label="Rotate right and read again">
              <RotateCw size={16} />
            </button>
            <button className="btn" disabled={busy} onClick={() => setCropping(true)}>
              <Crop size={16} /> Crop
            </button>
            <button className="btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Larger image' : 'Smaller image'}>
              {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </>
        )}
        {cropping && (
          <>
            <button
              className="btn"
              style={{ background: '#ffb547', color: '#16212b', borderColor: '#ffb547' }}
              disabled={!rect || rect.w < 0.1 || rect.h < 0.1 || busy}
              onClick={() => {
                onRescan({ cardId: card.id, crop: rect! });
                setCropping(false);
              }}
            >
              Read selected area
            </button>
            <button className="btn" onClick={() => setCropping(false)}>
              Cancel
            </button>
            <span className="tiny" style={{ color: '#cfd8de', alignSelf: 'center' }}>
              Drag a box around the card. Your original photo is kept.
            </span>
          </>
        )}
      </div>
    </div>
  );
}
