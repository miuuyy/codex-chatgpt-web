function releaseRetainedConversation(host, conversationKey) {
  const retained = [...host.turnTabs.values()].filter((tab) => (
    tab.status === "ready" && tab.conversationKey === conversationKey
  ));
  for (const tab of retained) {
    host.removeTurnTab(tab, false, true);
    host.logger.info("browser.tab_released", {
      tabId: tab.id,
      traceId: tab.traceId,
      status: tab.status,
      reason: "retained_conversation_superseded",
    });
  }
  return retained.length;
}

module.exports = { releaseRetainedConversation };
