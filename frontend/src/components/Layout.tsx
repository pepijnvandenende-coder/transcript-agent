import type { ReactNode } from "react";

// Phase 16: the one shared page shell every screen renders through, instead
// of each screen positioning its own title/status independently. Centers the
// title and status (`.page-header` in styles.css handles the actual
// centering) instead of leaving them flush top-left, and -- via `centered`
// -- vertically centers screens that are always short (the start screen,
// the end screen, the failure screen) instead of pinning sparse content to
// the top of an otherwise-empty page.
export function Layout({
  title,
  status,
  centered = false,
  children,
}: {
  title?: string;
  status?: ReactNode;
  centered?: boolean;
  children?: ReactNode;
}) {
  return (
    <main className={centered ? "page page-centered" : "page"}>
      {(title || status) && (
        <div className="page-header">
          {title && <h1>{title}</h1>}
          {status}
        </div>
      )}
      {children}
    </main>
  );
}
