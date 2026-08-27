import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CSSProperties } from 'react';

const codeStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  background: 'var(--cth-ink-100, rgba(127,127,127,0.16))',
  padding: '1px 4px',
  borderRadius: 3,
  fontSize: '0.92em'
};

/** Renders hive message bodies as GitHub-flavored markdown so *emphasis*, `code`,
 *  lists and links display formatted instead of as raw source. Block spacing is
 *  tightened so a short message doesn't get large default paragraph margins. */
export function Markdown({ text, style }: { text: string; style?: CSSProperties }): JSX.Element {
  return (
    <div style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
          ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ol>,
          li: ({ children }) => <li style={{ margin: '0 0 2px' }}>{children}</li>,
          code: ({ children }) => <code style={codeStyle}>{children}</code>,
          a: ({ children, href }) => <a href={href} style={{ color: 'var(--cth-sky, #4aa3ff)' }}>{children}</a>
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
