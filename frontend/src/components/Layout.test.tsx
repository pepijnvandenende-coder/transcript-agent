import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Layout } from "./Layout";

// Phase 16: the shared page shell every screen renders through -- centers
// the title/status instead of each screen positioning them independently,
// and (via `centered`) vertically centers screens with consistently sparse
// content instead of pinning them to the top of the page.
describe("components/Layout", () => {
  afterEach(cleanup);

  it("renders the title as an h1", () => {
    render(<Layout title="Werkoverleg Kickoff" />);
    expect(screen.getByRole("heading", { level: 1, name: "Werkoverleg Kickoff" })).toBeInTheDocument();
  });

  it("renders the status node alongside the title", () => {
    render(<Layout title="Werkoverleg Kickoff" status={<span>Voltooid</span>} />);
    expect(screen.getByText("Voltooid")).toBeInTheDocument();
  });

  it("renders children", () => {
    render(
      <Layout title="x">
        <p>Inhoud van het scherm</p>
      </Layout>,
    );
    expect(screen.getByText("Inhoud van het scherm")).toBeInTheDocument();
  });

  it("puts the title and status inside a centered header block", () => {
    const { container } = render(<Layout title="x" status={<span>Voltooid</span>} />);
    const header = container.querySelector(".page-header");
    expect(header).not.toBeNull();
    expect(header?.querySelector("h1")).not.toBeNull();
    expect(header?.textContent).toContain("Voltooid");
  });

  it("omits the header block entirely when there is no title and no status", () => {
    const { container } = render(<Layout>content</Layout>);
    expect(container.querySelector(".page-header")).toBeNull();
  });

  it("does not add the centered class by default", () => {
    const { container } = render(<Layout title="x" />);
    expect(container.querySelector("main")).toHaveClass("page");
    expect(container.querySelector("main")).not.toHaveClass("page-centered");
  });

  it("adds the centered class when centered is true", () => {
    const { container } = render(<Layout title="x" centered />);
    expect(container.querySelector("main")).toHaveClass("page", "page-centered");
  });
});
