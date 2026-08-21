import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SidePanel } from "./SidePanel";
import "./styles.css";

const root = document.getElementById("root");

if (!root) throw new Error("Panelshift root element was not found.");

createRoot(root).render(
  <StrictMode>
    <SidePanel />
  </StrictMode>,
);
