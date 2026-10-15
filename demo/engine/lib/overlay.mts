/**
 * On-screen cursor, click ripple and keystroke badge.
 *
 * Playwright's page video captures only the web contents, so the OS pointer
 * never appears in it. This injects a drawn pointer into the page that follows
 * synthetic mouse events, so viewers can see where the "user" is clicking.
 */
import type { Page } from "@playwright/test";

const OVERLAY_ID = "__demo_overlay";

/** Runs in the renderer. Idempotent. */
function installOverlay(id: string): void {
  if (document.getElementById(id)) return;
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  root.innerHTML = `
    <svg id="${id}_cursor" width="26" height="26" viewBox="0 0 24 24" style="position:absolute;left:0;top:0;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));">
      <path d="M4 2l15 9-6.5 1.6L9 19z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>
    <div id="${id}_key" style="position:absolute;left:50%;bottom:44px;transform:translateX(-50%);padding:10px 22px;border-radius:12px;background:rgba(20,20,24,.82);color:#fff;font:600 26px -apple-system,system-ui,sans-serif;letter-spacing:.04em;opacity:0;transition:opacity .15s;"></div>`;
  document.body.appendChild(root);

  const cursor = document.getElementById(`${id}_cursor`)!;
  document.addEventListener(
    "mousemove",
    (e) => {
      cursor.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`;
    },
    true,
  );
  document.addEventListener(
    "mousedown",
    (e) => {
      const ripple = document.createElement("div");
      ripple.style.cssText = `position:absolute;left:${e.clientX - 18}px;top:${e.clientY - 18}px;width:36px;height:36px;border-radius:50%;border:3px solid rgba(255,255,255,.9);background:rgba(120,170,255,.35);transition:transform .45s ease-out,opacity .45s ease-out;`;
      root.appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = "scale(1.9)";
        ripple.style.opacity = "0";
      });
      setTimeout(() => ripple.remove(), 600);
    },
    true,
  );
}

export async function ensureOverlay(page: Page): Promise<void> {
  await page.evaluate(installOverlay, OVERLAY_ID);
}

/** Flash a keycap badge (e.g. "⌘ N") at the bottom of the window. */
export async function showKey(page: Page, label: string, holdMs = 1100): Promise<void> {
  await ensureOverlay(page);
  await page.evaluate(
    ([id, text, hold]) => {
      const badge = document.getElementById(`${id}_key`)!;
      badge.textContent = text;
      badge.style.opacity = "1";
      setTimeout(() => (badge.style.opacity = "0"), hold as number);
    },
    [OVERLAY_ID, label, holdMs] as const,
  );
}
