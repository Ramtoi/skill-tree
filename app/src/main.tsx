import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { queryClient } from "@/lib/queryClient";
import App from "./App";
import "./App.css";

if (!document.documentElement.hasAttribute("data-density")) {
  document.documentElement.setAttribute("data-density", "default");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
