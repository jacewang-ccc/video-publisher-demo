// Douyin connector (content script) — MVP scaffold.
// This file intentionally avoids hard-coded selectors; real implementation should:
// - locate fields semantically (labels/nearby text)
// - support record/replay fallback
// - never bypass captcha/QR; pause and request user action

// Ensure bridge is injected so the web panel can talk to the extension.
try {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("bridge.js");
  s.type = "text/javascript";
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
} catch {}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;
  // TODO: handle per-tab prepare/commit commands with snapshot data.
  if (msg.type === "MPVPUB_PREPARE_DOUYIN") {
    console.log("[MVP] Douyin PREPARE", msg.snapshotId);
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg.type === "MPVPUB_COMMIT_DOUYIN") {
    console.log("[MVP] Douyin COMMIT", msg.snapshotId);
    sendResponse?.({ ok: true });
    return true;
  }
});

