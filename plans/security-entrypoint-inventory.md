# Public entrypoint inventory

Generated 2026-11-10T08:12:29.139Z by packages/convex/scripts/security-inventory.ts. Lexical classification of every exported Convex function and HTTP route; "unresolved" means no one has shown the boundary holds, never that it is safe.

| | count |
|---|---|
| generatedAt | 2026-11-10T08:12:29.139Z |
| files | 683 |
| functions | 2828 |
| public | 1668 |
| internal | 1160 |
| byKind | {"query":672,"mutation":833,"action":119,"httpAction":44} |
| byAuthClass | {"authenticated":1154,"token":41,"mixed":227,"anonymous":246} |
| unresolved | 600 |
| unresolvedByRisk | {"high":388,"medium":212,"low":0} |
| publicWithoutTests | 1312 |
| httpRoutes | 139 |
| openCells | 3352 |

## Unresolved public rows, highest risk first

| risk | id | kind | auth | ids | reason | tests |
|---|---|---|---|---|---|---|
| high | accountSwitch.acknowledgeBlocked | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | accountSwitch.recordCodexAccount | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | accountSwitch.requestAccountSwitch | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | agentReviews.cancelForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.claimForCli | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.doneForCli | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.retryForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.startForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.transcriptForCli | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | agentReviews.webTranscript | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | agentTasks.linkRunConversation | mutation | mixed | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | agentTasks.runTaskNow | mutation | mixed | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | agentTasks.webDelete | mutation | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | agentTasks.webRunNow | mutation | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 1 |
| high | anchors.setWorkspaceAgent | mutation | authenticated | teams,org_roles | authenticated caller, takes ids for teams,org_roles with no visible resource judge | 0 |
| high | artifactsHttp.dataJs | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | artifactsHttp.mediaSign | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | artifactsHttp.motionJs | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | artifactsHttp.playerJs | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | artifactsHttp.upload | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | assistant/entry.kick | action | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | billing.stripeWebhook | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | bookmarks.setBookmarkV2 | mutation | authenticated | conversations,messages | authenticated caller, takes ids for conversations,messages with no visible resource judge | 0 |
| high | bookmarks.toggleBookmark | mutation | authenticated | conversations,messages | authenticated caller, takes ids for conversations,messages with no visible resource judge | 0 |
| high | buckets.webAssignV2 | mutation | authenticated | conversations,inbox_buckets | authenticated caller, takes ids for conversations,inbox_buckets with no visible resource judge | 0 |
| high | buckets.webUpdateV2 | mutation | authenticated | inbox_buckets | authenticated caller, takes ids for inbox_buckets with no visible resource judge | 0 |
| high | callChat.post | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | callFace.ensureFaces | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | callGuests.acceptGuestNotice | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | callGuests.guestHeartbeat | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | callGuests.leaveCall | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | callGuests.mintGuestToken | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | callGuests.requestJoin | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | callGuests.revokeGuestLink | mutation | authenticated | call_guest_links | authenticated caller, takes ids for call_guest_links with no visible resource judge | 0 |
| high | callRecordings.guestStopRecording | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | calls.cancelInvite | mutation | authenticated | call_invites | authenticated caller, takes ids for call_invites with no visible resource judge | 0 |
| high | calls.putOutOfCall | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | calls.respondInvite | mutation | authenticated | call_invites | authenticated caller, takes ids for call_invites with no visible resource judge | 0 |
| high | capabilityBindings.bindCapability | mutation | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | chat.appendVoiceTranscript | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.archiveChannel | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chat.cancelVoiceBurst | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 2 |
| high | chat.deleteMessage | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.editMessage | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.finalizeVoiceBurst | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 1 |
| high | chat.markRead | mutation | authenticated | chat_channels,chat_messages | authenticated caller, takes ids for chat_channels,chat_messages with no visible resource judge | 0 |
| high | chat.removeChannelMember | mutation | authenticated | chat_channels,users | authenticated caller, takes ids for chat_channels,users with no visible resource judge | 0 |
| high | chat.replyAsAnchor | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.sendMessage | mutation | authenticated | chat_channels,chat_messages,conversations | authenticated caller, takes ids for chat_channels,chat_messages,conversations with no visible resource judge | 0 |
| high | chat.setAnchorFollow | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.setNotifyLevel | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chat.setThreadMuted | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.startVoiceBurst | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chat.stopAnchorReply | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.toggleReaction | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.updateChannel | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatAgents.addChannelAgents | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatAgents.removeChannelAgent | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatRounds.endRound | mutation | anonymous | chat_messages | no authentication or token check visible in the handler | 0 |
| high | chatRounds.skipFloor | mutation | anonymous | chat_messages | no authentication or token check visible in the handler | 0 |
| high | chatTyping.clear | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatTyping.set | mutation | authenticated | chat_channels,chat_messages | authenticated caller, takes ids for chat_channels,chat_messages with no visible resource judge | 0 |
| high | cloud.claimSharedCheckout | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | cloud.hostGitCredential | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | cloud.placeConversation | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | cloud.reportLocalMirror | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | cloud.reportPlacementFailure | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | cloud.reportPlacementProgress | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | cloud.requestBrowserSync | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | codeComments.discardPendingReview | mutation | authenticated | pull_requests | authenticated caller, takes ids for pull_requests with no visible resource judge | 0 |
| high | codeComments.resolve | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | codeComments.unresolve | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | collab.decideSendAccess | mutation | authenticated | collab_grants | authenticated caller, takes ids for collab_grants with no visible resource judge | 0 |
| high | collab.revokeSendAccess | mutation | authenticated | collab_grants | authenticated caller, takes ids for collab_grants with no visible resource judge | 0 |
| high | comments.resolveThread | mutation | authenticated | conversations,messages | authenticated caller, takes ids for conversations,messages with no visible resource judge | 0 |
| high | composerSuggestions.recordSuggestionOutcome | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversationLinks.webLinkConversation | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.adminFindChildren | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.adminLookupConversation | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.backfillImagePreview | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.clearParentMessageUuid | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.generateShareLink | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | conversations.killSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.pinToProfile | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | conversations.publishToDirectory | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.repairSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.restartSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setAvailableSkills | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setConversationIcon | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setFavoriteV2 | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setPrivacy | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setTeamVisibility | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.stopAndSendToSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.toggleFavorite | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.unpinFromProfile | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.updateSessionId | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.updateSlug | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | decisions.remove | mutation | mixed | decisions | authenticated caller, takes ids for decisions with no visible resource judge | 0 |
| high | decisionStacks.createStack | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | decisionStacks.createStackWith | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | decisionStacks.reorderStack | mutation | authenticated | session_decisions | authenticated caller, takes ids for session_decisions with no visible resource judge | 0 |
| high | deploys.report | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | deploys.request | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | deployTargets.pollNow | action | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | deployTargets.publish | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | deployTargets.recordShipPass | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | deployTargets.request | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | devices.claimDeviceAccount | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | devices.enqueueCloudAgentLoginCommand | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | devices.moveSessionToDevice | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | devices.requestDeviceUpdate | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | devices.setConversationOwner | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | devices.setDeviceSnippet | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | devices.setDeviceSshHost | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | docLab.runOnDoc | action | anonymous | docs | no authentication or token check visible in the handler | 0 |
| high | docSync.claimDrafts | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | executionBindings.activateAfterLegacyQuiescence | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.activateExecutionSuccessor | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.beginLegacyQuiescence | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.claimExecutionStart | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.claimNextDelivery | mutation | authenticated | conversations,pending_messages | authenticated caller, takes ids for conversations,pending_messages with no visible resource judge | 0 |
| high | executionBindings.disposePreReadyBinding | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.initializeFencedExecution | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.publishReadyBinding | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | executionBindings.publishRuntimeDisposition | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.rejectHeadDelivery | mutation | authenticated | conversations,pending_messages | authenticated caller, takes ids for conversations,pending_messages with no visible resource judge | 0 |
| high | executionBindings.requestExecutionSuccessor | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | executionBindings.requestExecutionSuccessorIntent | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | failedRunResume.resumeFromCli | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | flowLibrary.save | mutation | authenticated | session_flows | authenticated caller, takes ids for session_flows with no visible resource judge | 1 |
| high | flowVersions.fromCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | flowVersions.webPin | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | flowVersions.webRestore | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | follow.dropFollower | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | follow.follow | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | follow.reportView | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | googleOAuth.disconnect | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/a/ | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/data.js | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/email/unsubscribe | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/motion.js | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/player.js | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:OPTIONS ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:OPTIONS ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:POST ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:POST /cli/exchange-token | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | ingest.createSource | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | ingest.endOldKey | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | ingest.removeSource | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | ingest.rotateKey | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | ingest.setGroupStatus | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 1 |
| high | ingest.updateSource | mutation | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | ingestHttp.ingestPreflight | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | ingestHttp.ingestServe | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | initiatives.create | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | integrations.cliConnectToken | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | issueSync.addSource | mutation | authenticated | projects,teams | authenticated caller, takes ids for projects,teams with no visible resource judge | 0 |
| high | issueSync.cliAddSource | mutation | mixed | projects,teams | authenticated caller, takes ids for projects,teams with no visible resource judge | 0 |
| high | issueSync.cliRemoveSource | mutation | mixed | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.cliUpdateSource | mutation | mixed | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.removeSource | mutation | authenticated | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.updateSource | mutation | authenticated | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | judgeReview.defectsForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | judgeReview.diagnosisForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineActions.reportTry | mutation | mixed | line_tries | authenticated caller, takes ids for line_tries with no visible resource judge | 1 |
| high | lineTrial.addOutsideSpend | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.answerForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.dispatchNow | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.dropAtCardForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.rebuildForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.recardForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.removeOutsideSpend | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.setDispatch | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.setTrial | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | lineTrial.sweepForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | liveFlows.clearHold | mutation | authenticated | live_flows | authenticated caller, takes ids for live_flows with no visible resource judge | 0 |
| high | liveFlows.setBar | mutation | authenticated | live_flows | authenticated caller, takes ids for live_flows with no visible resource judge | 0 |
| high | liveFlows.setOn | mutation | authenticated | live_flows | authenticated caller, takes ids for live_flows with no visible resource judge | 0 |
| high | managedDevices.enrollHttp | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | managedSessions.registerManagedSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | managedSessions.updateAgentStatus | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 2 |
| high | messages.addMessage | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 1 |
| high | messages.addMessages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 3 |
| high | messages.backfillConversationImages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | messages.deleteMessagesByUuid | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | messages.generateMessageShareLink | mutation | mixed | messages | authenticated caller, takes ids for messages with no visible resource judge | 0 |
| high | metrics.createWatch | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | metrics.loadHistory | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | metrics.updateWatch | mutation | authenticated | users,org_roles,chat_channels | authenticated caller, takes ids for users,org_roles,chat_channels with no visible resource judge | 0 |
| high | modCalls.cliCall | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | modCalls.webCall | mutation | authenticated | mods | authenticated caller, takes ids for mods with no visible resource judge | 1 |
| high | modelCalls.setTeamBudget | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | modLocal.cliClaimCalls | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | modLocal.cliFinishCall | mutation | anonymous | mod_calls | no authentication or token check visible in the handler | 1 |
| high | modLocal.cliPublish | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | modLocal.cliReportLocal | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | modLocal.cliSetLocalDevice | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | modLogs.webLog | mutation | authenticated | mods | authenticated caller, takes ids for mods with no visible resource judge | 0 |
| high | modObjects.cliCreate | mutation | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | modObjects.cliUpdate | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | modObjects.webCreate | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | modObjects.webUpdate | mutation | authenticated | mod_objects | authenticated caller, takes ids for mod_objects with no visible resource judge | 0 |
| high | mods.cliPush | mutation | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | mods.cliRemove | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | mods.cliRollback | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | mods.cliSetEnabled | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | mods.webSetEnabled | mutation | authenticated | mods | authenticated caller, takes ids for mods with no visible resource judge | 0 |
| high | mods.webSetLocalDevice | mutation | authenticated | mods | authenticated caller, takes ids for mods with no visible resource judge | 0 |
| high | modSecrets.webSet | action | authenticated | mods | authenticated caller, takes ids for mods with no visible resource judge | 1 |
| high | modServer.call | action | authenticated | mods,teams | authenticated caller, takes ids for mods,teams with no visible resource judge | 1 |
| high | moments.bodyForCli | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | moments.complete | action | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | moments.judgedForCli | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | moments.publish | mutation | anonymous |  | no authentication or token check visible in the handler | 3 |
| high | moments.rejudgeForCli | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | moments.retryForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | notifications.markAsRead | mutation | authenticated | notifications | authenticated caller, takes ids for notifications with no visible resource judge | 0 |
| high | orgHealth.healthReport | action | anonymous | teams | no authentication or token check visible in the handler | 2 |
| high | orgInit.analysisInputs | action | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | orgLineMerge.record | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | orgProposals.create | mutation | authenticated | teams,docs | authenticated caller, takes ids for teams,docs with no visible resource judge | 0 |
| high | orgRoles.reparentSession | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | orgRoles.reset | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | orgRoles.setProjectLead | mutation | authenticated | projects | authenticated caller, takes ids for projects with no visible resource judge | 0 |
| high | orgRoles.setReports | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | orgRoute.route | action | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | orgTemplateLearning.learnPass | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | orgTemplateLearning.setLearning | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | orgTemplates.activateRoutine | mutation | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | orgTemplates.publish | mutation | authenticated | teams,_storage,projects | authenticated caller, takes ids for teams,_storage,projects with no visible resource judge | 0 |
| high | orgTemplates.setLessonStatus | mutation | authenticated | org_template_lessons,tasks | authenticated caller, takes ids for org_template_lessons,tasks with no visible resource judge | 0 |
| high | orgTemplates.upsertInstance | mutation | authenticated | teams,projects,org_roles | authenticated caller, takes ids for teams,projects,org_roles with no visible resource judge | 0 |
| high | orgTemplates.writeLoaderCharter | mutation | authenticated | teams,projects,org_roles | authenticated caller, takes ids for teams,projects,org_roles with no visible resource judge | 0 |
| high | passkeys.presenceFinish | action | anonymous |  | no authentication or token check visible in the handler | 5 |
| high | passkeys.remove | mutation | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | passkeys.rename | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | pathStats.refreshPathStats | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | pendingMessages.ackInjectedMessages | mutation | authenticated | conversations,pending_messages,messages | authenticated caller, takes ids for conversations,pending_messages,messages with no visible resource judge | 0 |
| high | pendingMessages.claimPendingMessageForDelivery | mutation | authenticated | pending_messages,conversations | authenticated caller, takes ids for pending_messages,conversations with no visible resource judge | 1 |
| high | pendingMessages.mergeQueued | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | pendingMessages.releaseQueued | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | pendingMessages.reorderQueued | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | pendingMessages.resetInjectedMessages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | pendingMessages.sendMessageToSession | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 2 |
| high | pendingMessages.sendMessageV2 | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 0 |
| high | permissionRules.remove | mutation | authenticated | permission_rules | authenticated caller, takes ids for permission_rules with no visible resource judge | 1 |
| high | permissions.cancelPermissionRequest | mutation | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 0 |
| high | permissions.createPermissionRequest | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 2 |
| high | permissions.updatePermissionStatus | mutation | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 3 |
| high | projectUpdates.webComment | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | projectUpdates.webDelete | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | projectUpdates.webEdit | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | pushRouter.reportPresence | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | quoteDrafts.save | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | regulatedDeletion.deleteCall | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 1 |
| high | regulatedDeletion.destroyTeam | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| high | replaysHttp.replayChunkPreflight | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | replaysHttp.replayFrameAdmit | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | replaysHttp.replayPlayerManifest | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | replaysHttp.replayPlayerManifestPreflight | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | replaysHttp.replaySign | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | reviews.addReviewComment | mutation | authenticated | reviews | authenticated caller, takes ids for reviews with no visible resource judge | 0 |
| high | reviews.resolveComment | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | reviews.unresolveComment | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | roleIcons.generate | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | savedViews.webDelete | mutation | authenticated | saved_views | authenticated caller, takes ids for saved_views with no visible resource judge | 0 |
| high | secrets.fulfill | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | secrets.refresh | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | secrets.rotate | action | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | sessionDecisions.ask | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 2 |
| high | sessionDecisions.grant | mutation | authenticated | org_roles,session_decisions | authenticated caller, takes ids for org_roles,session_decisions with no visible resource judge | 0 |
| high | sessionDecisions.reopen | mutation | authenticated | session_decisions | authenticated caller, takes ids for session_decisions with no visible resource judge | 0 |
| high | sessionDecisions.reportCommandRun | mutation | mixed | session_decisions | authenticated caller, takes ids for session_decisions with no visible resource judge | 1 |
| high | sessionDecisions.revoke | mutation | authenticated | decision_grants | authenticated caller, takes ids for decision_grants with no visible resource judge | 0 |
| high | sessionDelete.deleteSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | sessionGoals.cliControl | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | sessionGoals.cliSet | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | sessionMigrations.beginSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.confirmSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 1 |
| high | sessionMigrations.enqueueQuiesce | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.failSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.finishSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.reportSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | signals.dissolveForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | signals.ingest | action | anonymous |  | no authentication or token check visible in the handler | 4 |
| high | signals.mergeForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | signals.moveForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 2 |
| high | signals.splitForCli | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | slackSync.requestSlackMember | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | slackSync.shareMessageToSlack | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | slackSync.unlinkChannel | mutation | authenticated | slack_channel_links | authenticated caller, takes ids for slack_channel_links with no visible resource judge | 0 |
| high | slackSync.updateLink | mutation | authenticated | slack_channel_links | authenticated caller, takes ids for slack_channel_links with no visible resource judge | 0 |
| high | sources/app.doAction | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.grant | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.pollWatchNow | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.read | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.refresh | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.revoke | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/app.setWatchPaused | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/appViews.mint | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/posthog.importRecording | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/posthog.listInsights | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/posthog.listRecordings | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/posthog.query | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/replayBackfill.start | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/replayBackfill.stop | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/sentry.issueDetail | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/sentry.sentryWebhook | httpAction | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/sentry.setIssueStatus | action | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | sources/vendorProjects.listVendorProjects | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | sources/vendorReplay.importLinked | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | storyMode.generateStory | action | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | storyMode.generateSummary | action | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | subagentFleet.reportMergeBack | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | syncCursors.clearSyncCursors | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | syncCursors.updateSyncCursor | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | taskLinks.relate | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | taskLinks.supersede | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | taskLinks.unrelate | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | tasks.addDep | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | tasks.removeDep | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | taskWaits.addWait | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | taskWaits.removeWait | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamBilling.openSeatPortal | action | anonymous | teams | no authentication or token check visible in the handler | 1 |
| high | teamBilling.seatOffer | action | anonymous | teams | no authentication or token check visible in the handler | 1 |
| high | teamBilling.startSeatCheckout | action | anonymous | teams | no authentication or token check visible in the handler | 1 |
| high | teamDiscovery.confirmWorkEmailCode | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | teamDiscovery.decideRequest | mutation | authenticated | team_join_requests | authenticated caller, takes ids for team_join_requests with no visible resource judge | 1 |
| high | teamDiscovery.requestToJoin | mutation | anonymous | teams | no authentication or token check visible in the handler | 1 |
| high | teamDiscovery.sendWorkEmailCode | mutation | anonymous |  | no authentication or token check visible in the handler | 1 |
| high | teamDiscovery.setDiscoverable | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 2 |
| high | teamFeatures.setTeamFeature | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teamHosts.claimMember | mutation | anonymous | team_host_members | no authentication or token check visible in the handler | 0 |
| high | teamHosts.join | mutation | authenticated | team_hosts | authenticated caller, takes ids for team_hosts with no visible resource judge | 0 |
| high | teamHosts.removeMember | mutation | authenticated | team_host_members | authenticated caller, takes ids for team_host_members with no visible resource judge | 0 |
| high | teamHosts.rename | mutation | authenticated | team_hosts | authenticated caller, takes ids for team_hosts with no visible resource judge | 0 |
| high | teamHosts.reportMember | mutation | anonymous | team_host_members | no authentication or token check visible in the handler | 0 |
| high | teamHosts.unregister | mutation | authenticated | team_hosts | authenticated caller, takes ids for team_hosts with no visible resource judge | 0 |
| high | teamKit.adoptKitItem | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamKit.grantConsent | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamKit.kitUploadUrl | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamKit.publishKitItem | mutation | anonymous | teams,_storage | no authentication or token check visible in the handler | 0 |
| high | teamKit.removeItem | mutation | authenticated | team_kit_items | authenticated caller, takes ids for team_kit_items with no visible resource judge | 0 |
| high | teamKit.removeKitItemForToken | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamKit.reportKitApplied | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | teamKit.requestTeamKitPublish | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.createTeam | mutation | mixed | users | authenticated caller, takes ids for users with no visible resource judge | 4 |
| high | teams.deleteTeam | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| high | teams.inviteToTeam | mutation | mixed | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.joinTeam | mutation | mixed | users | authenticated caller, takes ids for users with no visible resource judge | 1 |
| high | teams.regenerateInviteCode | mutation | mixed | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 1 |
| high | teams.removeFromTeam | mutation | authenticated | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 1 |
| high | teams.removeMember | mutation | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| high | teams.renameTeam | mutation | authenticated | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.sendInviteEmail | mutation | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| high | teams.setActiveTeam | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| high | teams.setDefaultFlow | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.setMemberRole | mutation | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| high | teams.setTeamVisibility | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.updateTaskStatuses | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.updateTeamIcon | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | terminalStream.sendPaneInput | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | terminalStream.watchPane | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | threads.markAllRead | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 2 |
| high | transcripts.addRoute | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.appendSegments | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.attachRecording | mutation | authenticated | transcripts,_storage | authenticated caller, takes ids for transcripts,_storage with no visible resource judge | 1 |
| high | transcripts.beat | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 1 |
| high | transcripts.flush | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.setAgentFace | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.setRoutes | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.stop | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 1 |
| high | treeSnapshots.reportRewindStaged | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | users.deleteAccount | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | users.resumeSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | users.sendDaemonCommandToAll | mutation | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | users.updateDirectoryTeamMapping | mutation | authenticated | teams,conversations | authenticated caller, takes ids for teams,conversations with no visible resource judge | 0 |
| high | users.updateNotificationPreferences | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | workflow_runs.cancel | mutation | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.cancelFromCli | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.pauseAtGate | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 1 |
| high | workflow_runs.reaskFromCli | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.respondToGate | mutation | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.respondToGateFromCli | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 1 |
| medium | agentDefinitions.resolve | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | agentReviews.statusForCli | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | agentTasks.listRevisions | query | mixed | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | agentTasks.webListForConversation | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | agentTasks.webListForConversations | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | agentTasks.webListRevisions | query | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | agentTasks.webListRuns | query | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | anchors.getAnchorSpace | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | anchors.resolveAnchorForScope | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | assistant/incidents.thinkingAvailable | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | auth.signInProviders | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | authorityEvents.list | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | billing.billingAvailable | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | bookmarks.getConversationBookmarks | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | bookmarks.isBookmarked | query | authenticated | messages | authenticated caller, takes ids for messages with no visible resource judge | 0 |
| medium | callChat.list | query | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 1 |
| medium | callGuests.describeGuestLink | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | callGuests.getGuestState | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | calls.ringLive | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | capabilityBindings.listAdoptions | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | capabilityBindings.listConsents | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | changesQueries.inTheWorks | query | anonymous | teams | no authentication or token check visible in the handler | 1 |
| medium | changesQueries.listEditions | query | anonymous | teams | no authentication or token check visible in the handler | 1 |
| medium | changesQueries.listStories | query | anonymous | teams | no authentication or token check visible in the handler | 1 |
| medium | changesQueries.liveStatus | query | anonymous | teams | no authentication or token check visible in the handler | 1 |
| medium | changesQueries.storyEvidence | query | anonymous | change_stories | no authentication or token check visible in the handler | 1 |
| medium | changesQueries.storyLocation | query | anonymous | teams | no authentication or token check visible in the handler | 0 |
| medium | changesQueries.storySessions | query | anonymous | change_stories | no authentication or token check visible in the handler | 1 |
| medium | chat.getMessage | query | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| medium | chat.getThread | query | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| medium | chat.linesSince | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listChannelMembers | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listLiveVoiceBursts | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listMessages | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 1 |
| medium | chat.markThreadRead | mutation | authenticated | chat_messages | delegates to api.threads.markRead which calls requireCaller | 0 |
| medium | chatTyping.list | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 1 |
| medium | cloud.commandOutcome | query | authenticated | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 1 |
| medium | cloud.localMirrorActivity | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | cloud.placementTarget | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | codeComments.pendingReview | query | authenticated | pull_requests | authenticated caller, takes ids for pull_requests with no visible resource judge | 0 |
| medium | comments.getConversationCommentSummary | query | anonymous | conversations | no authentication or token check visible in the handler | 1 |
| medium | commentTwins.conversationComments | query | anonymous | conversations | no authentication or token check visible in the handler | 2 |
| medium | commits.webGet | query | authenticated | commits | authenticated caller, takes ids for commits with no visible resource judge | 0 |
| medium | conversationPages.list | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | conversations.conversationMessagesForCLI | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | conversations.debugConversationVisibility | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | conversations.exportConversationMessagesPage | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | conversations.feedForCLI | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.getConversations | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | conversations.getMessageCountsForReconciliation | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | conversations.getTeamUnreadCount | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.listConversations | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 3 |
| medium | conversations.listTeamInboxSessions | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | conversations.searchConversations | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | conversations.searchConversationTitles | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | conversations.searchForCLI | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 2 |
| medium | conversations.teamSessionsLiveness | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | daemonLogs.adminList | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 1 |
| medium | decisionShareOut.preview | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | deploys.forTask | query | authenticated | tasks | authenticated caller, takes ids for tasks with no visible resource judge | 0 |
| medium | deploys.stage | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | deployTargets.ciForCommits | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | deployTargets.shipPasses | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | deployTargets.view | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | devices.watchedCommandOutcome | query | authenticated | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 0 |
| medium | docs.webList | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | flowLibrary.sessionFlows | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | flowVersions.webVersions | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | follow.followersOf | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | follow.following | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | githubApp.listInstallations | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | googleOAuth.connectAvailable | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | images.getImageUrl | query | authenticated | _storage | authenticated caller, takes ids for _storage with no visible resource judge | 0 |
| medium | ingest.getSource | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.listEvents | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.listGroups | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.listSamples | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.listSources | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.removeSourcePreview | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | ingest.searchGroups | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | landedChanges.summary | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | lineActions.editability | query | authenticated | workflows | authenticated caller, takes ids for workflows with no visible resource judge | 1 |
| medium | lineStages.dispatch | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineStages.flow | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineStages.reviews | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTimeline.page | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.cards | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.cost | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.projects | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.runs | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.runsForCli | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.runTarget | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineTrial.spend | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | lineWorkspace.deploys | query | anonymous | projects | no authentication or token check visible in the handler | 1 |
| medium | lineWorkspace.occurrences | query | anonymous | projects | no authentication or token check visible in the handler | 1 |
| medium | linkPreviews.get | query | anonymous |  | no authentication or token check visible in the handler | 2 |
| medium | managedDevices.adminOverview | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | managedSessions.isSessionManaged | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | messages.findMessageByContentPublic | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationFileChangeIndex | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationFileChanges | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationImages | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationPages | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getFileChangeBodies | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getMessageCoverageV2 | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | metrics.listWatches | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | modCalls.cliGetCall | query | anonymous | mod_calls | no authentication or token check visible in the handler | 0 |
| medium | modCalls.webGetCall | query | authenticated | mod_calls | authenticated caller, takes ids for mod_calls with no visible resource judge | 1 |
| medium | modelCalls.budgetForTeam | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | modLocal.cliLocalMods | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | modLocal.cliPendingCall | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | modLocal.webState | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | modObjects.cliGet | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | modObjects.cliKinds | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | modObjects.cliList | query | anonymous | teams | no authentication or token check visible in the handler | 0 |
| medium | mods.cliGetVersion | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | mods.cliGuide | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | mods.cliList | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | mods.cliLogs | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | mods.cliVersions | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | mods.webList | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | modSecrets.cliList | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | moments.listForCli | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | moments.rulingsForCli | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | moments.showForCli | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | momentsFreshness.freshnessPage | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | org.roles | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | org.sessionsUnder | query | authenticated | users,org_roles,teams | authenticated caller, takes ids for users,org_roles,teams with no visible resource judge | 0 |
| medium | org.tree | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | orgChanges.list | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | orgHealth.health | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthCorePart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthDecisionsPart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthWorkPart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgInbox.loose | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgInit.analysisPart | query | authenticated | teams,conversations | authenticated caller, takes ids for teams,conversations with no visible resource judge | 0 |
| medium | orgInit.takeoverPreview | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgLineMerge.check | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | orgProposals.list | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | orgTemplateLearning.learning | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.catalog | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.get | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.instanceForRole | query | authenticated | org_roles | authenticated caller, takes ids for org_roles with no visible resource judge | 0 |
| medium | orgTemplates.listInstances | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.listLessons | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.release | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgWhere.where | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | pendingMessages.getPendingMessages | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | permissionRules.check | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| medium | permissions.getPendingPermissions | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | permissions.getPermissionDecision | query | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 1 |
| medium | pull_requests.getPRById | query | authenticated | pull_requests | authenticated caller, takes ids for pull_requests with no visible resource judge | 0 |
| medium | regulatedDeletion.destroyPreview | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | replays.browse | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | replays.list | query | anonymous | event_groups | no authentication or token check visible in the handler | 0 |
| medium | reviews.getPendingReviews | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | reviews.getReviewComments | query | authenticated | reviews | authenticated caller, takes ids for reviews with no visible resource judge | 0 |
| medium | savedViews.webGet | query | authenticated | saved_views | authenticated caller, takes ids for saved_views with no visible resource judge | 0 |
| medium | sessionCommands.results | query | mixed | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 0 |
| medium | sessionDecisions.findAskMessage | query | anonymous | session_decisions | no authentication or token check visible in the handler | 0 |
| medium | sessionDecisions.listForRole | query | authenticated | org_roles | authenticated caller, takes ids for org_roles with no visible resource judge | 0 |
| medium | sessionFlowRuns.forConversation | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 2 |
| medium | sessionFlowRuns.forTeam | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | sessionMigrations.checkoutHolder | query | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| medium | sessionMigrations.commandStatus | query | authenticated | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 0 |
| medium | sessionMigrations.sessionFacts | query | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| medium | signals.detailForWeb | query | authenticated | signals | authenticated caller, takes ids for signals with no visible resource judge | 1 |
| medium | signals.listForCli | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | signals.showForCli | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | sources/app.capabilities | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | sources/app.listCalls | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | storyMode.getStory | query | anonymous | conversations | no authentication or token check visible in the handler | 0 |
| medium | storyMode.getSummary | query | anonymous | conversations | no authentication or token check visible in the handler | 0 |
| medium | syncCursors.getSyncCursor | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | syncOutbox.getReceipts | query | authenticated | sync_outbox | authenticated caller, takes ids for sync_outbox with no visible resource judge | 0 |
| medium | tasks.list | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | tasks.listPage | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | teamBilling.getSeatState | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | teamDiscovery.discoveryNudge | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | teamDiscovery.discoverySettings | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | teamDiscovery.pendingRequests | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | teamKit.getKitVersion | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | teamKit.listKitItems | query | anonymous | teams | no authentication or token check visible in the handler | 0 |
| medium | teamKit.webVersions | query | authenticated | team_kit_items | authenticated caller, takes ids for team_kit_items with no visible resource judge | 0 |
| medium | teams.getActiveTeamContext | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | teams.getTeam | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | teams.getTeamMembersV2 | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | teams.getUserTeams | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | terminalStream.getPane | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | threads.listMine | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | threads.unreadByWorkspace | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | threads.unreadCount | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | transcripts.webCallPlaces | query | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| medium | transcripts.webGetCall | query | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| medium | treeSnapshots.editedPaths | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | users.getDirectoryTeamMappings | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | users.getPendingCommands | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 1 |
| medium | users.getSuggestedTeamProjects | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | users.getSyncSettings | query | anonymous |  | no authentication or token check visible in the handler | 0 |
| medium | users.getTeamMembers | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | users.getUserAbstractActivity | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | users.getUserActivityHeatmap | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | users.getUserByUsername | query | authenticated | users | anonymous callers gated on public_profile_enabled since 2026-09-23 (securityEntrypoints.test.ts) | 1 |
| medium | userSends.teamDay | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | whisk.connectAvailable | query | anonymous |  | no authentication or token check visible in the handler | 1 |
| medium | workflow_runs.get | query | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| medium | workflow_runs.graphOfRun | query | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| medium | workflow_runs.listRuns | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | workflow_runs.listRunsFromCli | query | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | workflows.poolForCli | query | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | workflows.webPool | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 2 |
| medium | workTimeline.since | query | anonymous |  | no authentication or token check visible in the handler | 0 |

## HTTP routes

| method | path | handler | auth | status |
|---|---|---|---|---|
| POST | ? | billing.stripeWebhook | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | /cli/a/ | http:GET /cli/a/ | anonymous | unresolved |
| GET | /cli/data.js | http:GET /cli/data.js | anonymous | unresolved |
| GET | /cli/email/unsubscribe | http:GET /cli/email/unsubscribe | anonymous | unresolved |
| POST | /cli/email/unsubscribe | http:GET /cli/email/unsubscribe | anonymous | unresolved |
| GET | /cli/motion.js | http:GET /cli/motion.js | anonymous | unresolved |
| GET | /cli/player.js | http:GET /cli/player.js | anonymous | unresolved |
| OPTIONS | ? | http:OPTIONS ? | anonymous | unresolved |
| OPTIONS | ? | http:OPTIONS ? | anonymous | unresolved |
| POST | ? | http:POST ? | anonymous | unresolved |
| POST | /cli/exchange-token | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/exchange-token | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/claim-auth | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/claim-auth | http:POST /cli/exchange-token | anonymous | unresolved |
| GET | /api/github-app/callback | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /api/webhooks/github-app | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /calls/face | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /api/webhooks/linear | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /api/webhooks/github | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/session-links | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/session-links | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/search | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/search | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/read | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/read | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/export | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/export | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/local-checkouts | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/local-checkouts | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/feed | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/feed | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/stable-context | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/stable-context | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/inbox | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/inbox | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/sessions | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/sessions | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/bookmark | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/bookmark | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/bookmark/list | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/bookmark/list | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/bookmark/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/bookmark/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/decisions | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/decisions | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/decisions/add | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/decisions/add | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/decisions/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/decisions/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/decide | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/decide | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/patterns | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/patterns | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/patterns/add | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/patterns/add | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/patterns/show | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/patterns/show | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/patterns/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/patterns/delete | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/similar | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/similar | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/blame | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/blame | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/blame/resolve | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/blame/resolve | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/sync-settings | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/sync-settings | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/sync-settings/update | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/sync-settings/update | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/log | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/log | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/log-batch | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/log-batch | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/teams | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/teams | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/teams/mappings | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/teams/mappings | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/teams/mappings/update | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/teams/mappings/update | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/conversations/count | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/conversations/count | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/conversations/delete-by-path | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/conversations/delete-by-path | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/teams/projects | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/teams/projects | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/heartbeat | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/heartbeat | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/command-result | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/command-result | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/fork | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/fork | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tree | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tree | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/create | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/create | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/list | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/resolve | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/list | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/due | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/due | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/claim | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/claim | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/renew-lease | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/renew-lease | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/complete | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/complete | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/fail | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/fail | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/cancel | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/cancel | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/pause | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/pause | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/resume | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/resume | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/run | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/run | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/update | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/update | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/tasks/history | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/tasks/history | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /api/webhooks/slack | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | ? | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | ? | http:POST /cli/exchange-token | anonymous | unresolved |
| GET | ? | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | ? | ingestHttp.ingestPreflight | anonymous | unresolved |
| OPTIONS | ? | ingestHttp.ingestPreflight | anonymous | unresolved |
| POST | ? | ingestHttp.ingestServe | anonymous | unresolved |
| POST | ? | managedDevices.enrollHttp | anonymous | unresolved |
| GET | ? | replaysHttp.replayChunk | authenticated | resolved |
| OPTIONS | ? | replaysHttp.replayChunkPreflight | anonymous | unresolved |
| POST | ? | replaysHttp.replayFrameAdmit | anonymous | unresolved |
| GET | ? | replaysHttp.replayPlayerManifest | anonymous | unresolved |
| OPTIONS | ? | replaysHttp.replayPlayerManifestPreflight | anonymous | unresolved |
| POST | ? | replaysHttp.replaySign | anonymous | unresolved |
| POST | /api/webhooks/sentry | sources/sentry.sentryWebhook | anonymous | unresolved |
