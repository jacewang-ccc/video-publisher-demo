// Service worker: receives commands from web (via bridge) and orchestrates Prepare/Commit.
// MVP: stub orchestration; real version will open tabs and coordinate per-platform connectors.

chrome.runtime.onInstalled.addListener(() => {
  // no-op
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "MPVPUB_PING") {
    chrome.runtime.sendMessage({ type: "MPVPUB_PONG" }).catch(() => {});
    return;
  }

  if (msg.type === "MPVPUB_PREPARE") {
    const snapshot = msg.snapshot;
    console.log("[MVP] PREPARE snapshot", snapshot?.id);

    prepareAll(snapshot)
      .then(() => {
        chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "prepare", state: "done", snapshotId: snapshot?.id }).catch(() => {});
      })
      .catch((err) => {
        chrome.runtime.sendMessage({
          type: "MPVPUB_STATUS",
          phase: "prepare",
          state: "failed",
          snapshotId: snapshot?.id,
          error: String(err?.message || err)
        }).catch(() => {});
      });

    sendResponse?.({ ok: true });
    return true;
  }

  if (msg.type === "MPVPUB_COMMIT") {
    console.log("[MVP] COMMIT snapshotId", msg.snapshotId);
    chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "commit", state: "started", snapshotId: msg.snapshotId }).catch(() => {});
    // TODO: instruct connectors to click publish; currently stub only.
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "commit", state: "done", snapshotId: msg.snapshotId }).catch(() => {});
    }, 300);
    sendResponse?.({ ok: true });
    return true;
  }
});

function openOrReuseTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ url }, (tabs) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      const existing = tabs?.[0];
      if (existing?.id) {
        chrome.tabs.update(existing.id, { active: false }, () => resolve(existing.id));
        return;
      }
      chrome.tabs.create({ url, active: false }, (tab) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(tab.id);
      });
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) return;
        if (!tab) return;
        if (tab.status === "complete") {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("Tab load timeout"));
        }
      });
    }, 500);
  });
}

async function prepareAll(snapshot) {
  if (!snapshot?.platforms) throw new Error("Missing snapshot.platforms");

  const targets = [
    { id: "douyin", url: "https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page" },
    { id: "xiaohongshu", url: "https://creator.xiaohongshu.com/new/note-manager" },
    { id: "channels", url: "https://channels.weixin.qq.com/platform/post/create?" },
    { id: "bilibili", url: "https://member.bilibili.com/platform/upload/video/frame" }
  ];

  for (const t of targets) {
    chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "prepare", state: "opening", platformId: t.id, snapshotId: snapshot.id }).catch(() => {});
    const tabId = await openOrReuseTab(t.url);
    await waitForTabComplete(tabId);
    chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "prepare", state: "opened", platformId: t.id, snapshotId: snapshot.id }).catch(() => {});

    if (t.id === "douyin") {
      await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          tabId,
          { type: "MPVPUB_PREPARE_DOUYIN", snapshotId: snapshot.id, fields: snapshot.platforms.douyin?.fields || null },
          () => resolve()
        );
      });
      chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "prepare", state: "prepared", platformId: t.id, snapshotId: snapshot.id }).catch(() => {});
    } else {
      // Other platforms not implemented in MVP skeleton yet.
      chrome.runtime.sendMessage({ type: "MPVPUB_STATUS", phase: "prepare", state: "prepared_stub", platformId: t.id, snapshotId: snapshot.id }).catch(() => {});
    }
  }
}
