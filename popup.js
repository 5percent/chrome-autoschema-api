async function queryStatus() {
  const status = document.getElementById("status");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "autoschema:get-status",
    });
    status.textContent = `已跟踪标签页: ${response?.trackedTabs ?? 0} | 白名单域名: ${response?.whitelistCount ?? 0}`;
  } catch {
    status.textContent = "状态读取失败";
  }
}

document.getElementById("openSidebar").addEventListener("click", async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
});

document.getElementById("clearData").addEventListener("click", async () => {
  const ok = confirm("确认清空本地采集数据？");
  if (!ok) return;
  await chrome.runtime.sendMessage({ type: "autoschema:clear" });
  await queryStatus();
});

queryStatus();
