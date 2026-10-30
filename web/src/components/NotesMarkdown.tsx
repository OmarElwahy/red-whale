// Notes as markdown (react-markdown): no raw HTML is rendered, and links open in a new tab without an opener.
import Markdown from 'react-markdown';

export function NotesMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      components={{
        a: ({ href, children: text }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {text}
          </a>
        ),
      }}
    >
      {children}
    </Markdown>
  );
}
