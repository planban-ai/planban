// Phone widths (Planban 2.0 plan, "Mobile and dropdowns"): the board becomes
// one scrolling list grouped by column, cards open full screen, and dialogs
// become sheets. 640 px and narrower counts as a phone.
import { useEffect, useState } from "react";

export const PHONE_QUERY = "(max-width: 640px)";

function matches() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
}

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * Publishes the on-screen keyboard's height as --keyboard-inset, so bars
 * pinned to the bottom (Save in the Spec and Plan editor) sit above it.
 * Phones that resize the page for the keyboard report 0.
 */
export function useKeyboardInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(inset)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, []);
}
