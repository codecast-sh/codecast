# Public entrypoint inventory

Generated 2026-09-24T00:10:31.887Z by packages/convex/scripts/security-inventory.ts. Lexical classification of every exported Convex function and HTTP route; "unresolved" means no one has shown the boundary holds, never that it is safe.

| | count |
|---|---|
| generatedAt | 2026-09-24T00:10:31.887Z |
| files | 266 |
| functions | 1663 |
| public | 1102 |
| internal | 561 |
| byKind | {"query":455,"mutation":575,"action":48,"httpAction":24} |
| byAuthClass | {"authenticated":856,"token":26,"mixed":191,"anonymous":29} |
| unresolved | 279 |
| unresolvedByRisk | {"high":183,"medium":96,"low":0} |
| publicWithoutTests | 1045 |
| httpRoutes | 121 |
| openCells | 1891 |

## Unresolved public rows, highest risk first

| risk | id | kind | auth | ids | reason | tests |
|---|---|---|---|---|---|---|
| high | accountSwitch.acknowledgeBlocked | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | accountSwitch.recordCodexAccount | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | accountSwitch.requestAccountSwitch | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | agentTasks.linkRunConversation | mutation | mixed | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | agentTasks.webDelete | mutation | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| high | artifacts.submitComments | mutation | authenticated | artifacts | authenticated caller, takes ids for artifacts with no visible resource judge | 1 |
| high | bookmarks.setBookmarkV2 | mutation | authenticated | conversations,messages | authenticated caller, takes ids for conversations,messages with no visible resource judge | 0 |
| high | bookmarks.toggleBookmark | mutation | authenticated | conversations,messages | authenticated caller, takes ids for conversations,messages with no visible resource judge | 0 |
| high | buckets.webAssignV2 | mutation | authenticated | conversations,inbox_buckets | authenticated caller, takes ids for conversations,inbox_buckets with no visible resource judge | 0 |
| high | buckets.webUpdateV2 | mutation | authenticated | inbox_buckets | authenticated caller, takes ids for inbox_buckets with no visible resource judge | 0 |
| high | calls.cancelInvite | mutation | authenticated | call_invites | authenticated caller, takes ids for call_invites with no visible resource judge | 0 |
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
| high | chat.sendMessage | mutation | authenticated | chat_channels,chat_messages | authenticated caller, takes ids for chat_channels,chat_messages with no visible resource judge | 0 |
| high | chat.setAnchorFollow | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.setNotifyLevel | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chat.startVoiceBurst | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chat.stopAnchorReply | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.toggleReaction | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | chat.updateChannel | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatTyping.clear | mutation | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| high | chatTyping.set | mutation | authenticated | chat_channels,chat_messages | authenticated caller, takes ids for chat_channels,chat_messages with no visible resource judge | 0 |
| high | cloud.claimSharedCheckout | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | cloud.hostGitCredential | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | cloud.placeConversation | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | cloud.reportPlacementFailure | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
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
| high | conversations.generateShareLink | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.pinToProfile | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.publishToDirectory | mutation | mixed | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.repairSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.restartSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setAvailableSkills | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setConversationIcon | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setFavoriteV2 | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setPrivacy | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.setTeamVisibility | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.toggleFavorite | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.unpinFromProfile | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.updateSessionId | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | conversations.updateSlug | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | decisions.remove | mutation | mixed | decisions | authenticated caller, takes ids for decisions with no visible resource judge | 0 |
| high | decisionStacks.createStack | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | decisionStacks.createStackWith | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | decisionStacks.reorderStack | mutation | authenticated | session_decisions | authenticated caller, takes ids for session_decisions with no visible resource judge | 0 |
| high | devices.claimDeviceAccount | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | devices.moveSessionToDevice | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | devices.setConversationOwner | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | devices.setDeviceSshHost | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
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
| high | follow.follow | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | follow.reportView | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | googleOAuth.disconnect | action | anonymous |  | no authentication or token check visible in the handler | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/a/ | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:GET /cli/email/unsubscribe | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:OPTIONS ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:OPTIONS ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:POST ? | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | http:POST /cli/exchange-token | httpAction | anonymous |  | route handler is inline or defined outside the export scan | 0 |
| high | initiatives.create | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | issueSync.addSource | mutation | authenticated | projects,teams | authenticated caller, takes ids for projects,teams with no visible resource judge | 0 |
| high | issueSync.cliAddSource | mutation | mixed | projects,teams | authenticated caller, takes ids for projects,teams with no visible resource judge | 0 |
| high | issueSync.cliRemoveSource | mutation | mixed | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.cliUpdateSource | mutation | mixed | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.removeSource | mutation | authenticated | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | issueSync.updateSource | mutation | authenticated | issue_sync_sources | authenticated caller, takes ids for issue_sync_sources with no visible resource judge | 0 |
| high | managedSessions.registerManagedSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | managedSessions.updateAgentStatus | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | messages.addMessage | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 0 |
| high | messages.addMessages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | messages.backfillConversationImages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | messages.deleteMessagesByUuid | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | messages.generateMessageShareLink | mutation | mixed | messages | authenticated caller, takes ids for messages with no visible resource judge | 0 |
| high | notifications.markAsRead | mutation | authenticated | notifications | authenticated caller, takes ids for notifications with no visible resource judge | 0 |
| high | orgHealth.healthReport | action | anonymous | teams | no authentication or token check visible in the handler | 1 |
| high | orgInit.analysisInputs | action | anonymous | teams | no authentication or token check visible in the handler | 0 |
| high | orgProposals.create | mutation | authenticated | teams,docs | authenticated caller, takes ids for teams,docs with no visible resource judge | 0 |
| high | orgRoles.reparentSession | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | orgRoles.setProjectLead | mutation | authenticated | projects | authenticated caller, takes ids for projects with no visible resource judge | 0 |
| high | orgRoles.setReports | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | orgTemplates.publish | mutation | authenticated | teams,_storage,projects | authenticated caller, takes ids for teams,_storage,projects with no visible resource judge | 0 |
| high | orgTemplates.setLessonStatus | mutation | authenticated | org_template_lessons,tasks | authenticated caller, takes ids for org_template_lessons,tasks with no visible resource judge | 0 |
| high | orgTemplates.upsertInstance | mutation | authenticated | projects,org_roles | authenticated caller, takes ids for projects,org_roles with no visible resource judge | 0 |
| high | pendingMessages.ackInjectedMessages | mutation | authenticated | conversations,pending_messages,messages | authenticated caller, takes ids for conversations,pending_messages,messages with no visible resource judge | 1 |
| high | pendingMessages.claimPendingMessageForDelivery | mutation | authenticated | pending_messages,conversations | authenticated caller, takes ids for pending_messages,conversations with no visible resource judge | 1 |
| high | pendingMessages.resetInjectedMessages | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 1 |
| high | pendingMessages.sendMessageToSession | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 0 |
| high | pendingMessages.sendMessageV2 | mutation | authenticated | conversations,_storage | authenticated caller, takes ids for conversations,_storage with no visible resource judge | 0 |
| high | permissions.cancelPermissionRequest | mutation | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 0 |
| high | permissions.createPermissionRequest | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | permissions.updatePermissionStatus | mutation | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 0 |
| high | projectUpdates.webComment | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | projectUpdates.webDelete | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | projectUpdates.webEdit | mutation | authenticated | project_updates | authenticated caller, takes ids for project_updates with no visible resource judge | 0 |
| high | publicComments.deletePublicComment | mutation | authenticated | public_comments | authenticated caller, takes ids for public_comments with no visible resource judge | 0 |
| high | pushRouter.reportPresence | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | reviews.addReviewComment | mutation | authenticated | reviews | authenticated caller, takes ids for reviews with no visible resource judge | 0 |
| high | reviews.resolveComment | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | reviews.unresolveComment | mutation | authenticated | review_comments | authenticated caller, takes ids for review_comments with no visible resource judge | 0 |
| high | savedViews.webDelete | mutation | authenticated | saved_views | authenticated caller, takes ids for saved_views with no visible resource judge | 0 |
| high | sessionDecisions.ask | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | sessionDecisions.grant | mutation | authenticated | org_roles,session_decisions | authenticated caller, takes ids for org_roles,session_decisions with no visible resource judge | 0 |
| high | sessionDecisions.reopen | mutation | authenticated | session_decisions | authenticated caller, takes ids for session_decisions with no visible resource judge | 0 |
| high | sessionDecisions.revoke | mutation | authenticated | decision_grants | authenticated caller, takes ids for decision_grants with no visible resource judge | 0 |
| high | sessionMigrations.beginSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.confirmSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.enqueueQuiesce | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.failSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.finishSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | sessionMigrations.reportSession | mutation | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| high | slackSync.shareMessageToSlack | mutation | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| high | slackSync.unlinkChannel | mutation | authenticated | slack_channel_links | authenticated caller, takes ids for slack_channel_links with no visible resource judge | 0 |
| high | slackSync.updateLink | mutation | authenticated | slack_channel_links | authenticated caller, takes ids for slack_channel_links with no visible resource judge | 0 |
| high | storyMode.generateStory | action | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | storyMode.generateSummary | action | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | syncCursors.clearSyncCursors | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | syncCursors.updateSyncCursor | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | teamFeatures.setTeamFeature | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.createTeam | mutation | mixed | users | authenticated caller, takes ids for users with no visible resource judge | 1 |
| high | teams.deleteTeam | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| high | teams.inviteToTeam | mutation | mixed | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.joinTeam | mutation | mixed | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | teams.regenerateInviteCode | mutation | mixed | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.removeFromTeam | mutation | authenticated | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.removeMember | mutation | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| high | teams.renameTeam | mutation | authenticated | teams,users | authenticated caller, takes ids for teams,users with no visible resource judge | 0 |
| high | teams.sendInviteEmail | mutation | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| high | teams.setActiveTeam | mutation | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
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
| high | transcripts.setRoutes | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| high | transcripts.stop | mutation | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 1 |
| high | users.resumeSession | mutation | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| high | users.updateDirectoryTeamMapping | mutation | authenticated | teams,conversations | authenticated caller, takes ids for teams,conversations with no visible resource judge | 0 |
| high | users.updateNotificationPreferences | mutation | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| high | workflow_runs.pauseAtGate | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.respondToGate | mutation | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| high | workflow_runs.respondToGateFromCli | mutation | mixed | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| medium | agentDefinitions.resolve | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | agentTasks.listRevisions | query | mixed | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | agentTasks.webListForConversation | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | agentTasks.webListForConversations | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | agentTasks.webListRevisions | query | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | agentTasks.webListRuns | query | authenticated | agent_tasks | authenticated caller, takes ids for agent_tasks with no visible resource judge | 0 |
| medium | anchors.getAnchorSpace | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | anchors.resolveAnchorForScope | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | bookmarks.getConversationBookmarks | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | bookmarks.isBookmarked | query | authenticated | messages | authenticated caller, takes ids for messages with no visible resource judge | 0 |
| medium | chat.getMessage | query | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| medium | chat.getThread | query | authenticated | chat_messages | authenticated caller, takes ids for chat_messages with no visible resource judge | 0 |
| medium | chat.linesSince | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listChannelMembers | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listLiveVoiceBursts | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.listMessages | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | chat.markThreadRead | mutation | authenticated | chat_messages | delegates to api.threads.markRead which calls requireCaller | 0 |
| medium | chatTyping.list | query | authenticated | chat_channels | authenticated caller, takes ids for chat_channels with no visible resource judge | 0 |
| medium | cloud.commandOutcome | query | authenticated | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 1 |
| medium | cloud.placementTarget | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | codeComments.pendingReview | query | authenticated | pull_requests | authenticated caller, takes ids for pull_requests with no visible resource judge | 0 |
| medium | commits.webGet | query | authenticated | commits | authenticated caller, takes ids for commits with no visible resource judge | 0 |
| medium | conversations.debugConversationVisibility | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | conversations.feedForCLI | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.getConversations | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | conversations.getMessageCountsForReconciliation | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | conversations.getTeamUnreadCount | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.listConversations | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | conversations.listTeamInboxSessions | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.searchConversations | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.searchConversationTitles | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.searchForCLI | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | conversations.teamSessionsLiveness | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | daemonLogs.adminList | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | docs.webList | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | follow.followersOf | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | follow.following | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | githubApp.listInstallations | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | images.getImageUrl | query | authenticated | _storage | authenticated caller, takes ids for _storage with no visible resource judge | 0 |
| medium | managedSessions.isSessionManaged | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | messages.findMessageByContentPublic | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationFileChangeIndex | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationFileChanges | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getConversationImages | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getFileChangeBodies | query | token | conversations | token authenticated but takes ids without a visible resource judge | 0 |
| medium | messages.getMessageCoverageV2 | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | org.sessionsUnder | query | authenticated | users,org_roles,teams | authenticated caller, takes ids for users,org_roles,teams with no visible resource judge | 0 |
| medium | org.tree | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | orgChanges.list | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | orgHealth.health | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthCorePart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthDecisionsPart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgHealth.healthWorkPart | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgInit.analysisPart | query | authenticated | teams,conversations | authenticated caller, takes ids for teams,conversations with no visible resource judge | 0 |
| medium | orgInit.takeoverPreview | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgProposals.list | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.catalog | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.get | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.instanceForRole | query | authenticated | org_roles | authenticated caller, takes ids for org_roles with no visible resource judge | 0 |
| medium | orgTemplates.listInstances | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | orgTemplates.listLessons | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | pendingMessages.getConversationPendingMessage | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | pendingMessages.getPendingMessages | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | permissions.getPendingPermissions | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | permissions.getPermissionDecision | query | authenticated | pending_permissions | authenticated caller, takes ids for pending_permissions with no visible resource judge | 0 |
| medium | pull_requests.getPRById | query | authenticated | pull_requests | authenticated caller, takes ids for pull_requests with no visible resource judge | 0 |
| medium | reviews.getPendingReviews | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | reviews.getReviewComments | query | authenticated | reviews | authenticated caller, takes ids for reviews with no visible resource judge | 0 |
| medium | savedViews.webGet | query | authenticated | saved_views | authenticated caller, takes ids for saved_views with no visible resource judge | 0 |
| medium | sessionDecisions.findAskMessage | query | anonymous | session_decisions | no authentication or token check visible in the handler | 0 |
| medium | sessionDecisions.get | query | anonymous | session_decisions | no authentication or token check visible in the handler | 0 |
| medium | sessionDecisions.listForRole | query | authenticated | org_roles | authenticated caller, takes ids for org_roles with no visible resource judge | 0 |
| medium | sessionMigrations.commandStatus | query | authenticated | daemon_commands | authenticated caller, takes ids for daemon_commands with no visible resource judge | 0 |
| medium | sessionMigrations.sessionFacts | query | authenticated | session_migrations | authenticated caller, takes ids for session_migrations with no visible resource judge | 0 |
| medium | storyMode.getStory | query | anonymous | conversations | no authentication or token check visible in the handler | 0 |
| medium | storyMode.getSummary | query | anonymous | conversations | no authentication or token check visible in the handler | 0 |
| medium | syncCursors.getSyncCursor | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | teams.getActiveTeamContext | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | teams.getTeam | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | teams.getTeamMembersV2 | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | terminalStream.getPane | query | authenticated | conversations | authenticated caller, takes ids for conversations with no visible resource judge | 0 |
| medium | threads.listMine | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 1 |
| medium | threads.unreadCount | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | transcripts.cliGetCall | query | mixed | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| medium | transcripts.webGetCall | query | authenticated | transcripts | authenticated caller, takes ids for transcripts with no visible resource judge | 0 |
| medium | users.getPendingCommands | query | authenticated | users | authenticated caller, takes ids for users with no visible resource judge | 0 |
| medium | users.getSuggestedTeamProjects | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | users.getTeamMembers | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | users.getUserAbstractActivity | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | users.getUserActivityHeatmap | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | users.getUserActivityPunchcard | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | users.getUserByUsername | query | authenticated | users | anonymous callers gated on public_profile_enabled since 2026-09-23 (securityEntrypoints.test.ts) | 1 |
| medium | users.getUserProfileFeed | query | authenticated | users,teams | authenticated caller, takes ids for users,teams with no visible resource judge | 0 |
| medium | workflow_runs.get | query | authenticated | workflow_runs | authenticated caller, takes ids for workflow_runs with no visible resource judge | 0 |
| medium | workflow_runs.listRuns | query | authenticated | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |
| medium | workflow_runs.listRunsFromCli | query | mixed | teams | authenticated caller, takes ids for teams with no visible resource judge | 0 |

## HTTP routes

| method | path | handler | auth | status |
|---|---|---|---|---|
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | ? | http:GET ? | anonymous | unresolved |
| GET | /cli/a/ | http:GET /cli/a/ | anonymous | unresolved |
| GET | /cli/email/unsubscribe | http:GET /cli/email/unsubscribe | anonymous | unresolved |
| POST | /cli/email/unsubscribe | http:GET /cli/email/unsubscribe | anonymous | unresolved |
| OPTIONS | ? | http:OPTIONS ? | anonymous | unresolved |
| OPTIONS | ? | http:OPTIONS ? | anonymous | unresolved |
| POST | ? | http:POST ? | anonymous | unresolved |
| POST | /cli/exchange-token | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/exchange-token | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /cli/claim-auth | http:POST /cli/exchange-token | anonymous | unresolved |
| OPTIONS | /cli/claim-auth | http:POST /cli/exchange-token | anonymous | unresolved |
| GET | /api/github-app/callback | http:POST /cli/exchange-token | anonymous | unresolved |
| POST | /api/webhooks/github-app | http:POST /cli/exchange-token | anonymous | unresolved |
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
