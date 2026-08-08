import React from "react";
import { createRoot } from "react-dom/client";
import { StudioRoot } from "./app";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StudioRoot />
  </React.StrictMode>,
);
