// Injected bridge to relay window.postMessage <-> extension runtime.
(() => {
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data.type !== "string") return;
    if (!data.type.startsWith("MPVPUB_")) return;

    chrome.runtime.sendMessage(data).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return;
    if (!message.type.startsWith("MPVPUB_")) return;
    window.postMessage(message, "*");
  });
})();

