// Inject bridge into the web panel so window.postMessage can reach the extension.
try {
  const s = document.createElement("script");
  s.src = chrome.runtime.getURL("bridge.js");
  s.type = "text/javascript";
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();
} catch {}

