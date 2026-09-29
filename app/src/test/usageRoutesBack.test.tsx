import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router-dom";
import { fromNav, usageProjectBackTarget } from "@/lib/backTarget";
import { UsageProjectRoute } from "@/screens/usage/UsageProjectRoute";
import { UsageSessionRoute } from "@/screens/usage/UsageSessionRoute";
import { renderWithProviders } from "./helpers";

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function view(initialRoute: string | { pathname: string; state?: unknown }) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/usage" element={<LocationProbe />} />
        <Route path="/usage/project/:name" element={<UsageProjectRoute />} />
        <Route path="/usage/session/:id" element={<UsageSessionRoute />} />
      </Routes>
      <LocationProbe />
    </>,
    { initialRoute },
  );
}

describe("usage drill-down back controls", () => {
  it("returns from the project route to Usage", async () => {
    view("/usage/project/moon-base");
    expect(await screen.findByRole("button", { name: "Back to Usage" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back to Usage" }));
    expect(screen.getAllByTestId("location")[0]).toHaveTextContent("/usage");
  });

  it("hands an allowed usage window to the standalone project host", async () => {
    view({ pathname: "/usage/project/moon-base", state: { usageWindow: 90 } });
    expect(await screen.findByRole("radio", { name: "90 days" })).toBeChecked();
  });

  it("ignores an invalid usage window in navigation state", async () => {
    localStorage.removeItem("st:usage:window");
    view({ pathname: "/usage/project/moon-base", state: { usageWindow: 365 } });
    expect(await screen.findByRole("radio", { name: "30 days" })).toBeChecked();
  });

  it("returns from a session opened by the project route to that project", async () => {
    view({
      pathname: "/usage/session/session-1",
      state: fromNav(usageProjectBackTarget("moon-base")).state,
    });
    expect(await screen.findByRole("button", { name: "Back to moon-base" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back to moon-base" }));
    expect(screen.getAllByTestId("location")[0]).toHaveTextContent("/usage/project/moon-base");
  });
});
