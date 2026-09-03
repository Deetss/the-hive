import { memo, useMemo, type CSSProperties } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const codeStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  background: 'var(--cth-ink-100, rgba(127,127,127,0.16))',
  padding: '1px 4px',
  borderRadius: 3,
  fontSize: '0.92em'
};

const preStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-mono)',
  background: 'var(--cth-ink-100, rgba(127,127,127,0.16))',
  padding: '6px 8px',
  borderRadius: 3,
  fontSize: '0.92em',
  margin: '0 0 6px',
  maxWidth: '100%',
  overflowX: 'auto',
  boxSizing: 'border-box'
};

const REMARK_PLUGINS = [remarkGfm];

const markdownComponents: Components = {
  p: ({ children, node: _node, style, ...props }) => (
    <p {...props} style={{ ...style, margin: '0 0 6px' }}>{children}</p>
  ),
  ul: ({ children, node: _node, style, ...props }) => (
    <ul {...props} style={{ ...style, margin: '0 0 6px', paddingLeft: 18 }}>{children}</ul>
  ),
  ol: ({ children, node: _node, style, ...props }) => (
    <ol {...props} style={{ ...style, margin: '0 0 6px', paddingLeft: 18 }}>{children}</ol>
  ),
  li: ({ children, node: _node, style, ...props }) => (
    <li {...props} style={{ ...style, margin: '0 0 2px' }}>{children}</li>
  ),
  pre: ({ children, node: _node, style, ...props }) => (
    <pre {...props} style={{ ...preStyle, ...style }}>{children}</pre>
  ),
  code: (props) => {
    const { children, node: _node, style, ...rest } = props;
    const { inline: _inline, ...restWithoutInline } = rest as typeof rest & { inline?: unknown };
    return (
      <code
        {...restWithoutInline}
        style={{ ...codeStyle, ...(style ?? {}) }}
      >
        {children}
      </code>
    );
  },
  a: ({ children, node: _node, style, href, ...props }) => (
    <a {...props} href={href} style={{ ...style, color: 'var(--cth-sky, #4aa3ff)' }}>
      {children}
    </a>
  )
};

interface MarkdownProps {
  text: string;
  style?: CSSProperties;
}

const isSameStyle = (a?: CSSProperties, b?: CSSProperties): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
};

/** Renders hive message bodies as GitHub-flavored markdown so *emphasis*, `code`,
 *  lists and links display formatted instead of as raw source. Block spacing is
 *  tightened so a short message doesn't get large default paragraph margins. */
function MarkdownInner({ text, style }: MarkdownProps): JSX.Element {
  const rendered = useMemo(() => (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  ), [text]);

  return <div style={{ overflowWrap: 'break-word', wordBreak: 'break-word', minWidth: 0, ...style }}>{rendered}</div>;
}

export const Markdown = memo(MarkdownInner, (prev, next) => prev.text === next.text && isSameStyle(prev.style, next.style));





