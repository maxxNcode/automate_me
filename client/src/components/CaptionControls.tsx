import { useState, useEffect, useRef } from 'react';

type CaptionPosition = 'top' | 'center' | 'bottom';

interface CaptionControlsProps {
  position: CaptionPosition;
  bgColor: string;
  onPositionChange: (pos: CaptionPosition) => void;
  onBgColorChange: (color: string) => void;
  disabled?: boolean;
}

const POSITION_OPTIONS: { value: CaptionPosition; label: string; icon: string }[] = [
  { value: 'top', label: 'Top', icon: '⊤' },
  { value: 'center', label: 'Center', icon: '⊡' },
  { value: 'bottom', label: 'Bottom', icon: '⊥' },
];

const PRESET_COLORS = [
  { label: 'Dark', value: 'black' },
  { label: 'Blue', value: 'blue' },
  { label: 'Purple', value: 'purple' },
  { label: 'Red', value: 'red' },
  { label: 'Green', value: 'green' },
  { label: 'None', value: 'transparent' },
];

export function CaptionControls({
  position,
  bgColor,
  onPositionChange,
  onBgColorChange,
  disabled,
}: CaptionControlsProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const [customColor, setCustomColor] = useState('');
  const colorRef = useRef<HTMLDivElement>(null);

  // Close color picker on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) {
        setColorOpen(false);
      }
    }
    if (colorOpen) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [colorOpen]);

  const handleCustomColor = () => {
    if (customColor.trim()) {
      // Accept hex, rgb, rgba, hsl
      const color = customColor.trim();
      if (/^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|[a-zA-Z]+)$/.test(color)) {
        onBgColorChange(color);
      }
      setCustomColor('');
      setColorOpen(false);
    }
  };

  return (
    <div className="caption-controls">
      <div className="caption-controls-header">
        <svg className="caption-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <line x1="6" y1="10" x2="6" y2="10" />
          <line x1="10" y1="10" x2="14" y2="10" />
          <line x1="18" y1="10" x2="18" y2="10" />
          <line x1="6" y1="14" x2="10" y2="14" />
          <line x1="14" y1="14" x2="18" y2="14" />
        </svg>
        <span>Captions</span>
      </div>

      <div className="caption-controls-body">
        {/* Position */}
        <div className="caption-field">
          <label className="caption-label">Position</label>
          <div className="caption-pos-group">
            {POSITION_OPTIONS.map(opt => (
              <button
                key={opt.value}
                type="button"
                className={`caption-pos-btn ${position === opt.value ? 'active' : ''}`}
                onClick={() => onPositionChange(opt.value)}
                disabled={disabled}
                title={opt.label}
              >
                <span className="caption-pos-icon">{opt.icon}</span>
                <span className="caption-pos-label">{opt.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Background Color */}
        <div className="caption-field" ref={colorRef}>
          <label className="caption-label">Background</label>
          <div className="caption-color-row">
            <div className="caption-color-presets">
              {PRESET_COLORS.map(c => (
                <button
                  key={c.value}
                  type="button"
                  className={`caption-color-swatch ${bgColor === c.value ? 'active' : ''}`}
                  style={{ backgroundColor: c.value === 'transparent' ? 'transparent' : c.value, borderColor: c.value === 'transparent' ? 'var(--border)' : c.value }}
                  onClick={() => onBgColorChange(c.value)}
                  disabled={disabled}
                  title={c.label}
                >
                  {c.value === 'transparent' && (
                    <span className="caption-color-none">/</span>
                  )}
                </button>
              ))}
            </div>
            <div className="caption-color-custom">
              <button
                type="button"
                className={`caption-color-picker-btn ${colorOpen ? 'open' : ''}`}
                onClick={() => setColorOpen(!colorOpen)}
                disabled={disabled}
                title="Custom color"
              >
                <span className="caption-color-current" style={{ backgroundColor: bgColor }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="12" height="12">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {colorOpen && (
                <div className="caption-color-dropdown">
                  <input
                    type="text"
                    value={customColor}
                    onChange={e => setCustomColor(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCustomColor(); }}
                    placeholder="#ff0000 or rgba(255,0,0,0.5)"
                    className="caption-color-input"
                    autoFocus
                  />
                  <button type="button" className="caption-color-apply" onClick={handleCustomColor}>
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
