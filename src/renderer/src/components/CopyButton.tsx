import { useState, useCallback } from 'react';

/**
 * CopyButton — a clipboard 📋 icon that briefly shows ✓ on success.
 * Usage: <CopyButton value="some text to copy" />
 */
export function CopyButton({ value, title }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback: create a temp textarea for browsers that restrict clipboard
      const el = document.createElement('textarea');
      el.value = value;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={title ?? `Copy to clipboard`}
      aria-label="Copy to clipboard"
      style={{
        flexShrink: 0,
        padding: '3px 6px',
        border: 'none',
        background: copied ? 'var(--cth-mint)' : 'var(--cth-paper-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        cursor: 'pointer',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 12,
        color: copied ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
        transition: 'background 0.15s, color 0.15s',
        userSelect: 'none',
        lineHeight: 1
      }}
    >
      {copied ? '✓' : '📋'}
    </button>
  );
}
